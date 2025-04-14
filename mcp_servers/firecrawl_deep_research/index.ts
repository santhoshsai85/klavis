import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
    Tool,
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import FirecrawlApp from '@mendable/firecrawl-js';
import dotenv from 'dotenv';

dotenv.config();

// Tool definition for deep research
const DEEP_RESEARCH_TOOL: Tool = {
    name: 'firecrawl_deep_research',
    description:
        'Conduct deep research on a query using web crawling, search, and AI analysis.',
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The query to research',
            },
            maxDepth: {
                type: 'number',
                description: 'Maximum depth of research iterations (1-5)',
            },
            timeLimit: {
                type: 'number',
                description: 'Time limit in seconds (30-180)',
            },
            maxUrls: {
                type: 'number',
                description: 'Maximum number of URLs to analyze (1-50)',
            },
        },
        required: ['query'],
    },
};

// Server implementation
const server = new Server(
    {
        name: 'firecrawl-deep-research-mcp',
        version: '1.0.0',
    },
    {
        capabilities: {
            tools: {},
            logging: {},
        },
    }
);

// Get API config
const FIRECRAWL_API_URL = process.env.FIRECRAWL_API_URL;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

// Check if API key is required (only for cloud service)
if (!FIRECRAWL_API_URL && !FIRECRAWL_API_KEY) {
    console.error(
        'Error: FIRECRAWL_API_KEY environment variable is required when using the cloud service'
    );
    process.exit(1);
}

// Initialize Firecrawl client with optional API URL
const client = new FirecrawlApp({
    apiKey: FIRECRAWL_API_KEY || '',
    ...(FIRECRAWL_API_URL ? { apiUrl: FIRECRAWL_API_URL } : {}),
});

// Configuration for retries
const CONFIG = {
    retry: {
        maxAttempts: Number(process.env.FIRECRAWL_RETRY_MAX_ATTEMPTS) || 3,
        initialDelay: Number(process.env.FIRECRAWL_RETRY_INITIAL_DELAY) || 1000,
        maxDelay: Number(process.env.FIRECRAWL_RETRY_MAX_DELAY) || 10000,
        backoffFactor: Number(process.env.FIRECRAWL_RETRY_BACKOFF_FACTOR) || 2,
    },
};

// Credit tracking
interface CreditUsage {
    total: number;
    lastCheck: number;
}

const creditUsage: CreditUsage = {
    total: 0,
    lastCheck: Date.now(),
};

// Utility function for delay
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let isStdioTransport = false;

function safeLog(
    level:
        | 'error'
        | 'debug'
        | 'info'
        | 'notice'
        | 'warning'
        | 'critical'
        | 'alert'
        | 'emergency',
    data: any
): void {
    if (isStdioTransport) {
        // For stdio transport, log to stderr to avoid protocol interference
        console.error(
            `[${level}] ${typeof data === 'object' ? JSON.stringify(data) : data}`
        );
    } else {
        // For other transport types, use the normal logging mechanism
        server.sendLoggingMessage({ level, data });
    }
}

// Retry logic with exponential backoff
async function withRetry<T>(
    operation: () => Promise<T>,
    context: string,
    attempt = 1
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        const isRateLimit =
            error instanceof Error &&
            (error.message.includes('rate limit') || error.message.includes('429'));

        if (isRateLimit && attempt < CONFIG.retry.maxAttempts) {
            const delayMs = Math.min(
                CONFIG.retry.initialDelay *
                Math.pow(CONFIG.retry.backoffFactor, attempt - 1),
                CONFIG.retry.maxDelay
            );

            safeLog(
                'warning',
                `Rate limit hit for ${context}. Attempt ${attempt}/${CONFIG.retry.maxAttempts}. Retrying in ${delayMs}ms`
            );

            await delay(delayMs);
            return withRetry(operation, context, attempt + 1);
        }

        throw error;
    }
}

// Credit monitoring
async function updateCreditUsage(creditsUsed: number): Promise<void> {
    creditUsage.total += creditsUsed;
    safeLog('info', `Credit usage: ${creditUsage.total} credits used total`);
}

// Credit usage type guard
function hasCredits(response: any): response is { creditsUsed: number } {
    return 'creditsUsed' in response && typeof response.creditsUsed === 'number';
}

// Utility function to trim trailing whitespace from text responses
function trimResponseText(text: string): string {
    return text.trim();
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [DEEP_RESEARCH_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startTime = Date.now();
    try {
        const { name, arguments: args } = request.params;

        // Log incoming request with timestamp
        safeLog(
            'info',
            `[${new Date().toISOString()}] Received request for tool: ${name}`
        );

        if (!args) {
            throw new Error('No arguments provided');
        }

        if (name === 'firecrawl_deep_research') {
            if (!args || typeof args !== 'object' || !('query' in args)) {
                throw new Error('Invalid arguments for firecrawl_deep_research');
            }

            try {
                const researchStartTime = Date.now();
                safeLog('info', `Starting deep research for query: ${args.query}`);

                const response = await client.deepResearch(
                    args.query as string,
                    {
                        maxDepth: args.maxDepth as number,
                        timeLimit: args.timeLimit as number,
                        maxUrls: args.maxUrls as number,
                    },
                    // Activity callback
                    (activity: any) => {
                        safeLog(
                            'info',
                            `Research activity: ${activity.message} (Depth: ${activity.depth})`
                        );
                    },
                    // Source callback
                    (source: any) => {
                        safeLog(
                            'info',
                            `Research source found: ${source.url}${source.title ? ` - ${source.title}` : ''}`
                        );
                    }
                );

                // Log performance metrics
                safeLog(
                    'info',
                    `Deep research completed in ${Date.now() - researchStartTime}ms`
                );

                if (!response.success) {
                    throw new Error(response.error || 'Deep research failed');
                }

                // Monitor credits for cloud API
                if (!FIRECRAWL_API_URL && hasCredits(response)) {
                    await updateCreditUsage(response.creditsUsed);
                }

                // Format the results
                const formattedResponse = {
                    finalAnalysis: response.data.finalAnalysis,
                    activities: response.data.activities,
                    sources: response.data.sources,
                };

                return {
                    content: [
                        {
                            type: 'text',
                            text: trimResponseText(formattedResponse.finalAnalysis),
                        },
                    ],
                    isError: false,
                };
            } catch (error) {
                const errorMessage =
                    error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: 'text', text: trimResponseText(errorMessage) }],
                    isError: true,
                };
            }
        } else {
            return {
                content: [
                    { type: 'text', text: trimResponseText(`Unknown tool: ${name}`) },
                ],
                isError: true,
            };
        }
    } catch (error) {
        // Log detailed error information
        safeLog('error', {
            message: `Request failed: ${error instanceof Error ? error.message : String(error)}`,
            tool: request.params.name,
            arguments: request.params.arguments,
            timestamp: new Date().toISOString(),
            duration: Date.now() - startTime,
        });
        return {
            content: [
                {
                    type: 'text',
                    text: trimResponseText(
                        `Error: ${error instanceof Error ? error.message : String(error)}`
                    ),
                },
            ],
            isError: true,
        };
    } finally {
        // Log request completion with performance metrics
        safeLog('info', `Request completed in ${Date.now() - startTime}ms`);
    }
});

const app = express();

// to support multiple simultaneous connections we have a lookup object from
// sessionId to transport
const transports: { [sessionId: string]: SSEServerTransport } = {};

app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    res.on("close", () => {
        delete transports[transport.sessionId];
    });
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports[sessionId];
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(400).send('No transport found for sessionId');
    }
});

const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Firecrawl Deep Research MCP Server running on port ${PORT}`);
}); 