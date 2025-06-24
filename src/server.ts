import express from 'express';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PrintifyAPI } from './printify-api.js';
import { ReplicateClient } from './replicate-client.js';
import { z } from 'zod';
import crypto from 'crypto';

const __dirname = path.resolve();

const app = express();
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// CORS configuration for web clients like Claude.com
app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  // Allow requests from Claude.com and other MCP web clients
  const allowedOrigins = [
    'https://claude.ai',
    'https://www.claude.ai',
    'https://claude.com',
    'https://www.claude.com',
    'http://localhost:3000', // For development
  ];
  
  if (origin && allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else {
    // Allow any origin in production if needed
    res.header('Access-Control-Allow-Origin', '*');
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key, X-Replicate-Token, mcp-session-id, Last-Event-ID');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Store user sessions and their API keys
interface UserSession {
  printifyApiKey: string;
  shopId?: string;
  printifyClient: PrintifyAPI;
  replicateClient?: ReplicateClient;
  lastAccessed: number;
}

const userSessions = new Map<string, UserSession>();

// Clean up inactive sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  const sessionTimeout = 60 * 60 * 1000; // 1 hour
  
  for (const [userId, session] of userSessions.entries()) {
    if (now - session.lastAccessed > sessionTimeout) {
      userSessions.delete(userId);
      console.log(`Cleaned up inactive session for user ${userId}`);
    }
  }
}, 30 * 60 * 1000); // Run every 30 minutes

// API key validation middleware
const validateApiKey = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apiKey = req.headers['x-api-key'] as string;
  
  if (!apiKey) {
    return res.status(401).json({
      error: 'API key required. Please provide your Printify API key in the X-API-Key header.'
    });
  }
  
  // Store API key in request for later use
  (req as any).apiKey = apiKey;
  next();
};

// Create MCP server instance for a specific user session
function createUserMcpServer(session: UserSession) {
  const server = new McpServer({
    name: "printify-mcp",
    version: "1.0.0",
    vendor: "printify"
  });

  // List shops tool
  server.tool(
    "list-shops",
    {},
    async () => {
      const shops = await session.printifyClient.getShops();
      return {
        content: [{
          type: "text",
          text: JSON.stringify(shops, null, 2)
        }]
      };
    }
  );

  // Switch shop tool
  server.tool(
    "switch-shop",
    {
      shopId: z.string().describe("The ID of the shop to switch to")
    },
    async ({ shopId }) => {
      await session.printifyClient.setShop(shopId);
      return {
        content: [{
          type: "text",
          text: `Switched to shop ${shopId}`
        }]
      };
    }
  );

  // List products tool
  server.tool(
    "list-products",
    {
      page: z.number().optional().default(1).describe("Page number"),
      limit: z.number().optional().default(10).describe("Number of products per page")
    },
    async ({ page, limit }) => {
      const products = await session.printifyClient.getProducts(page, limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(products, null, 2)
        }]
      };
    }
  );

  // Get product details
  server.tool(
    "get-product",
    {
      productId: z.string().describe("Product ID")
    },
    async ({ productId }) => {
      const product = await session.printifyClient.getProduct(productId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(product, null, 2)
        }]
      };
    }
  );

  // Create product tool
  server.tool(
    "create-product",
    {
      title: z.string().describe("Product title"),
      description: z.string().describe("Product description"),
      blueprintId: z.number().describe("Blueprint ID"),
      printProviderId: z.number().describe("Print provider ID"),
      variants: z.array(z.object({
        variantId: z.number().describe("Variant ID"),
        price: z.number().describe("Price in cents (e.g., 1999 for $19.99)"),
        isEnabled: z.boolean().optional().default(true).describe("Whether the variant is enabled")
      })).describe("Product variants"),
      printAreas: z.record(z.string(), z.object({
        position: z.string().describe("Print position (e.g., 'front', 'back')"),
        imageId: z.string().describe("Image ID from Printify uploads")
      })).optional().describe("Print areas for the product")
    },
    async (params) => {
      const product = await session.printifyClient.createProduct(params);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(product, null, 2)
        }]
      };
    }
  );

  // Update product tool
  server.tool(
    "update-product",
    {
      productId: z.string().describe("Product ID"),
      title: z.string().optional().describe("Product title"),
      description: z.string().optional().describe("Product description"),
      variants: z.array(z.object({
        variantId: z.number().describe("Variant ID"),
        price: z.number().describe("Price in cents (e.g., 1999 for $19.99)"),
        isEnabled: z.boolean().optional().describe("Whether the variant is enabled")
      })).optional().describe("Product variants")
    },
    async ({ productId, ...updateData }) => {
      const product = await session.printifyClient.updateProduct(productId, updateData);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(product, null, 2)
        }]
      };
    }
  );

  // Delete product tool
  server.tool(
    "delete-product",
    {
      productId: z.string().describe("Product ID")
    },
    async ({ productId }) => {
      await session.printifyClient.deleteProduct(productId);
      return {
        content: [{
          type: "text",
          text: `Product ${productId} deleted successfully`
        }]
      };
    }
  );

  // Publish product tool
  server.tool(
    "publish-product",
    {
      productId: z.string().describe("Product ID"),
      publishDetails: z.object({
        title: z.boolean().optional(),
        description: z.boolean().optional(),
        images: z.boolean().optional(),
        variants: z.boolean().optional(),
        tags: z.boolean().optional()
      }).optional().describe("What to publish")
    },
    async ({ productId, publishDetails }) => {
      const result = await session.printifyClient.publishProduct(productId, publishDetails);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Upload image tool
  server.tool(
    "upload-image",
    {
      fileName: z.string().describe("File name"),
      url: z.string().describe("URL of the image to upload, path to local file, or base64 encoded image data")
    },
    async ({ fileName, url }) => {
      const image = await session.printifyClient.uploadImage(fileName, url);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(image, null, 2)
        }]
      };
    }
  );

  // Generate and upload image tool (if Replicate is configured)
  if (session.replicateClient) {
    server.tool(
      "generate-and-upload-image",
      {
        prompt: z.string().describe("Text prompt for image generation"),
        fileName: z.string().describe("File name for the uploaded image"),
        width: z.number().optional().default(1024).describe("Image width in pixels"),
        height: z.number().optional().default(1024).describe("Image height in pixels"),
        aspectRatio: z.string().optional().describe("Aspect ratio (e.g., '16:9', '4:3', '1:1')"),
        numInferenceSteps: z.number().optional().default(25).describe("Number of inference steps"),
        guidanceScale: z.number().optional().default(7.5).describe("Guidance scale"),
        negativePrompt: z.string().optional().default("low quality, bad quality").describe("Negative prompt"),
        seed: z.number().optional().describe("Random seed for reproducible generation")
      },
      async (params) => {
        const imagePath = await session.replicateClient!.generateImage(params.prompt, params);
        const image = await session.printifyClient.uploadImage(params.fileName, imagePath);
        return {
          content: [{
            type: "text",
            text: JSON.stringify(image, null, 2)
          }]
        };
      }
    );
  }

  // Get blueprints tool
  server.tool(
    "get-blueprints",
    {
      page: z.number().optional().default(1).describe("Page number"),
      limit: z.number().optional().default(10).describe("Number of blueprints per page")
    },
    async ({ page, limit }) => {
      const blueprints = await session.printifyClient.getBlueprints(page, limit);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(blueprints, null, 2)
        }]
      };
    }
  );

  // Get blueprint details
  server.tool(
    "get-blueprint",
    {
      blueprintId: z.string().describe("Blueprint ID")
    },
    async ({ blueprintId }) => {
      const blueprint = await session.printifyClient.getBlueprint(blueprintId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(blueprint, null, 2)
        }]
      };
    }
  );

  // Get print providers tool
  server.tool(
    "get-print-providers",
    {
      blueprintId: z.string().describe("Blueprint ID")
    },
    async ({ blueprintId }) => {
      const providers = await session.printifyClient.getPrintProviders(blueprintId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(providers, null, 2)
        }]
      };
    }
  );

  // Get variants tool
  server.tool(
    "get-variants",
    {
      blueprintId: z.string().describe("Blueprint ID"),
      printProviderId: z.string().describe("Print provider ID")
    },
    async ({ blueprintId, printProviderId }) => {
      const variants = await session.printifyClient.getVariants(blueprintId, printProviderId);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(variants, null, 2)
        }]
      };
    }
  );

  return server;
}

// Generate unique API endpoint for each user
function generateUserEndpoint(): string {
  return crypto.randomBytes(16).toString('hex');
}

// Main MCP endpoint - handles all requests for a specific user
app.all('/api/mcp/a/:userId/mcp', async (req, res) => {
  const userId = req.params.userId;
  
  try {
    // Get user session
    const session = userSessions.get(userId);
    
    if (!session) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Session not found. Please register first.',
        },
        id: null,
      });
    }
    
    // Update last accessed time
    session.lastAccessed = Date.now();
    
    // Create new MCP server instance for this request (following SDK pattern)
    const server = createUserMcpServer(session);
    
    // Create transport in stateless mode
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });
    
    // Connect server to transport
    await server.connect(transport);
    
    // Handle the request
    await transport.handleRequest(req, res, req.body);
    
    // Clean up when response is done
    res.on('close', () => {
      transport.close().catch(console.error);
      server.close().catch(console.error);
    });
    
  } catch (error: any) {
    console.error('Error handling MCP request:', error);
    
    // Return proper JSON-RPC error response
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: error.message || 'Internal server error',
          data: {
            type: error.name,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
          }
        },
        id: null,
      });
    }
  }
});

// Registration endpoint - generates a unique URL for the user
app.post('/api/register', async (req, res) => {
  const { printifyApiKey, replicateApiToken } = req.body;
  
  if (!printifyApiKey) {
    return res.status(400).json({ error: 'Printify API key is required' });
  }
  
  try {
    // Validate the API key by initializing the client
    console.log('Registration attempt with API key:', printifyApiKey ? printifyApiKey.substring(0, 10) + '...' : 'None');
    const printifyClient = new PrintifyAPI(printifyApiKey);
    
    console.log('Initializing Printify API...');
    await printifyClient.initialize();
    
    // Generate unique user ID
    const userId = generateUserEndpoint();
    
    // Store session
    const session: UserSession = {
      printifyApiKey,
      printifyClient,
      lastAccessed: Date.now(),
    };
    
    if (replicateApiToken) {
      session.replicateClient = new ReplicateClient(replicateApiToken);
    }
    
    userSessions.set(userId, session);
    
    // Return the unique MCP endpoint URL
    const baseUrl = getBaseUrl();
    console.log(`Generated MCP URL with BASE_URL: ${baseUrl}`);
    
    res.json({
      success: true,
      mcpUrl: `${baseUrl}/api/mcp/a/${userId}/mcp`,
      instructions: 'Add this URL to your MCP client (e.g., Claude.com) to connect to your Printify account.'
    });
  } catch (error: any) {
    res.status(400).json({ 
      error: 'Invalid API key or failed to connect to Printify',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    activeSessions: userSessions.size,
    timestamp: new Date().toISOString()
  });
});

// Serve the registration UI
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: path.join(__dirname, 'public') });
});

// Global error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start server
const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0'; // Bind to all interfaces for container compatibility

// Debug environment variables
console.log('=== Environment Variable Debug ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('PORT:', process.env.PORT);
console.log('BASE_URL:', process.env.BASE_URL);
console.log('RAILWAY_PUBLIC_DOMAIN:', process.env.RAILWAY_PUBLIC_DOMAIN);
console.log('RAILWAY_STATIC_URL:', process.env.RAILWAY_STATIC_URL);
console.log('RAILWAY_ENVIRONMENT_NAME:', process.env.RAILWAY_ENVIRONMENT_NAME);
console.log('Available env vars:', Object.keys(process.env).filter(k => 
  !k.includes('SECRET') && 
  !k.includes('TOKEN') && 
  !k.includes('PASSWORD') &&
  !k.includes('KEY')
).sort());
console.log('=================================');

// Helper function to get the base URL
function getBaseUrl(): string {
  // Try various Railway environment variables
  let baseUrl = process.env.BASE_URL || 
                process.env.RAILWAY_PUBLIC_DOMAIN ||
                process.env.RAILWAY_STATIC_URL ||
                `http://localhost:${PORT}`;
  
  // If we have a Railway public domain, use it
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN;
  }
  
  // Ensure URL has protocol
  if (baseUrl && !baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
    baseUrl = `https://${baseUrl}`;
  }
  
  return baseUrl;
}

app.listen(PORT, HOST, () => {
  const baseUrl = getBaseUrl();
  
  console.log(`Printify MCP Web Server running on ${HOST}:${PORT}`);
  console.log(`Detected BASE_URL: ${baseUrl}`);
  console.log(`Health check available at: ${baseUrl}/health`);
  console.log(`Register at: ${baseUrl}`);
}).on('error', (error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
