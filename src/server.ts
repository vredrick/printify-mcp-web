import express from 'express';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PrintifyAPI, PrintifyErrorCode } from './printify-api.js';
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
  try {
    // Ensure the Printify client has a valid shop ID
    if (!session.printifyClient.shopId) {
      const shops = session.printifyClient.shops || [];
      if (shops.length > 0) {
        // Re-initialize with the first available shop
        session.printifyClient.shopId = String(shops[0].id);
        console.log(`Recovered shop ID: ${shops[0].title} (${shops[0].id})`);
      } else {
        console.warn('No shops available for session, API calls may fail');
      }
    }
    
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
      title: z.string().describe("Product title (e.g., 'Cool T-Shirt Design')"),
      description: z.string().describe("Product description for customers"),
      blueprintId: z.number().describe("Blueprint ID (e.g., 5 for Bella+Canvas 3001 T-Shirt)"),
      printProviderId: z.number().describe("Print provider ID (get from get-print-providers)"),
      variants: z.array(z.object({
        variantId: z.number().describe("Variant ID from get-variants"),
        price: z.number().describe("Price in cents (e.g., 1999 for $19.99)"),
        isEnabled: z.boolean().optional().default(true).describe("Whether to sell this variant")
      })).describe("Product variants with pricing"),
      printAreas: z.record(z.string(), z.object({
        position: z.string().describe("Print position (e.g., 'front', 'back')"),
        imageId: z.string().describe("Image ID from upload-image"),
        x: z.number().optional().default(0).describe("Horizontal position (0-1, default: 0 for center)"),
        y: z.number().optional().default(0).describe("Vertical position (0-1, default: 0 for center)"),
        scale: z.number().optional().default(1).describe("Scale factor (0.5-2, default: 1)"),
        angle: z.number().optional().default(0).describe("Rotation angle in degrees (default: 0)")
      })).optional().describe("Design placement on product with positioning")
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

  // Simplified product creation tool
  server.tool(
    "create-product-simple",
    {
      title: z.string().describe("Product title"),
      description: z.string().describe("Product description"),
      blueprintId: z.number().describe("Blueprint ID (use get-popular-blueprints for common IDs)"),
      imageId: z.string().describe("Image ID from upload-image"),
      profitMargin: z.string().optional().default("50%").describe("Profit margin (e.g., '50%' or '100%')"),
      includeColors: z.string().optional().default("white,black").describe("Comma-separated colors to include"),
      includeSizes: z.string().optional().default("M,L,XL,2XL").describe("Comma-separated sizes to include")
    },
    async ({ title, description, blueprintId, imageId, profitMargin, includeColors, includeSizes }) => {
      try {
        // Get blueprint details first
        const blueprint = await session.printifyClient.getBlueprint(blueprintId.toString());
        
        // Use first available print provider
        const providers = await session.printifyClient.getPrintProviders(blueprintId.toString());
        if (!providers || providers.length === 0) {
          throw new Error('No print providers available for this blueprint');
        }
        
        const printProviderId = providers[0].id;
        
        // Get variants
        const variantsData = await session.printifyClient.getVariants(
          blueprintId.toString(), 
          printProviderId.toString()
        );
        
        // Parse requested colors and sizes
        const requestedColors = includeColors.toLowerCase().split(',').map(c => c.trim());
        const requestedSizes = includeSizes.toUpperCase().split(',').map(s => s.trim());
        
        // Filter and price variants
        const variants = variantsData.variants
          .filter((v: any) => {
            const colorMatch = requestedColors.some(color => 
              v.title.toLowerCase().includes(color)
            );
            const sizeMatch = requestedSizes.some(size => 
              v.title.includes(size)
            );
            return colorMatch && sizeMatch;
          })
          .map((v: any) => {
            const pricing = session.printifyClient.calculatePricing(v.cost, profitMargin);
            return {
              variantId: v.id,
              price: pricing.price,
              isEnabled: true
            };
          });

        if (variants.length === 0) {
          throw new Error('No variants match the requested colors and sizes');
        }

        // Create product with simplified parameters
        const productData = {
          title,
          description,
          blueprintId,
          printProviderId,
          variants,
          printAreas: {
            front: {
              position: 'front',
              imageId
            }
          }
        };

        const product = await session.printifyClient.createProduct(productData);
        
        return {
          content: [{
            type: "text",
            text: `Product created successfully!

Title: ${product.title}
ID: ${product.id}
Blueprint: ${blueprint.title}
Variants enabled: ${variants.length}
Profit margin: ${profitMargin}

Product details:
${JSON.stringify(product, null, 2)}

Next steps:
- Use publish-product to make it available in your store
- Use update-product to modify details
- Use get-product to view current status`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error creating product: ${error.message}

Common issues:
- Invalid blueprint ID (use get-popular-blueprints for valid IDs)
- Image not uploaded (use upload-image first)
- No variants match colors/sizes (try 'white,black' and 'S,M,L,XL')

Example usage:
create-product-simple
  title: "Cool T-Shirt"
  description: "Amazing design"
  blueprintId: 5
  imageId: "your-image-id"
  profitMargin: "50%"
  includeColors: "white,black"
  includeSizes: "M,L,XL"`
          }]
        };
      }
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
      fileName: z.string().describe("File name (e.g., 'my-design.png')"),
      url: z.string().describe(`Image source - supports multiple formats:
        - Direct URL: https://example.com/image.png
        - Google Drive: https://drive.google.com/file/d/{id}/view (auto-converted)
        - Local file: /path/to/image.png
        - Base64 data: data:image/png;base64,iVBORw0...`)
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

  // Search blueprints tool
  server.tool(
    "search-blueprints",
    {
      category: z.string().optional().describe("Category: 'apparel', 'accessories', or 'home'"),
      type: z.string().optional().describe("Type: 'tshirt', 'hoodie', 'mug', 'totebag', 'poster', etc.")
    },
    async ({ category, type }) => {
      try {
        const blueprints = await session.printifyClient.searchBlueprints(category, type);
        
        // Add helpful message based on search
        let message = '';
        if (category && type) {
          message = `Showing ${type} products in ${category} category:\n\n`;
        } else if (category) {
          message = `Showing all products in ${category} category:\n\n`;
        } else if (type) {
          message = `Showing all ${type} products:\n\n`;
        }
        
        return {
          content: [{
            type: "text",
            text: message + JSON.stringify(blueprints, null, 2)
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error searching blueprints: ${error.message}\n\nTry:\n- Using a valid category: 'apparel', 'accessories', or 'home'\n- Using a valid type: 'tshirt', 'hoodie', 'mug', etc.\n- Calling get-popular-blueprints for quick access to common products`
          }]
        };
      }
    }
  );

  // Get popular blueprints tool
  server.tool(
    "get-popular-blueprints",
    {},
    async () => {
      try {
        const blueprints = await session.printifyClient.getPopularBlueprints();
        
        return {
          content: [{
            type: "text",
            text: `Popular blueprints for quick product creation:\n\n${JSON.stringify(blueprints, null, 2)}\n\nUse these blueprint IDs with create-product or create-product-simple for faster setup.`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error getting popular blueprints: ${error.message}`
          }]
        };
      }
    }
  );

  // Calculate pricing tool
  server.tool(
    "calculate-pricing",
    {
      baseCost: z.number().describe("Base cost in cents (e.g., 1200 for $12.00)"),
      profitMargin: z.string().describe("Desired profit margin (e.g., '50%' or '0.5')")
    },
    async ({ baseCost, profitMargin }) => {
      const pricing = session.printifyClient.calculatePricing(baseCost, profitMargin);
      
      return {
        content: [{
          type: "text",
          text: `Pricing calculation:
Base cost: $${(baseCost / 100).toFixed(2)}
Profit margin: ${profitMargin}
Selling price: $${(pricing.price / 100).toFixed(2)}
Profit per sale: $${(pricing.profit / 100).toFixed(2)}

Use ${pricing.price} as the price when creating variants.`
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
      page: z.number().optional().default(1).describe("Page number (default: 1)"),
      limit: z.number().optional().default(5).describe("Number of blueprints per page (default: 5, max: 10, use 3 for better reliability)")
    },
    async ({ page, limit }) => {
      try {
        const blueprints = await session.printifyClient.getBlueprints(page, limit);
        
        // Add helpful message if using fallback data
        if (blueprints._fallback) {
          return {
            content: [{
              type: "text",
              text: `${blueprints._message}\n\n${JSON.stringify(blueprints, null, 2)}`
            }]
          };
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(blueprints, null, 2)
          }]
        };
      } catch (error: any) {
        // Provide helpful error message
        if (error.code === PrintifyErrorCode.TIMEOUT) {
          return {
            content: [{
              type: "text",
              text: `Error: Request timed out. The blueprints catalog is large and may take time to load.\n\nTry:\n1. Using a smaller limit (e.g., limit=3)\n2. Checking your internet connection\n3. Enabling debug mode with PRINTIFY_DEBUG=true\n\nError details: ${error.message}`
            }]
          };
        }
        throw error;
      }
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

  // ===== PROMPTS =====
  
  // Product creation wizard prompt
  server.prompt(
    'create-product-wizard',
    'Interactive wizard to create a Printify product with best practices',
    {
      productType: z.string().describe('Type of product (t-shirt, mug, hoodie, etc)'),
      designDescription: z.string().describe('Description of your design concept'),
      targetAudience: z.string().optional().describe('Target customer demographic'),
      priceRange: z.string().optional().describe('Desired price range (budget, mid-range, premium)')
    },
    async ({ productType, designDescription, targetAudience, priceRange }) => {
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I want to create a ${productType} product on Printify. 

Design concept: ${designDescription}
${targetAudience ? `Target audience: ${targetAudience}` : ''}
${priceRange ? `Price range: ${priceRange}` : ''}

Please help me:
1. Find the best blueprint for a ${productType}
2. Select an appropriate print provider based on quality and price
3. Choose the right variants (sizes/colors) for my target market
4. Set competitive pricing
5. Generate or prepare my design for upload
6. Create the product with optimal settings

Guide me through each step and explain the best practices.`
          }
        }]
      };
    }
  );

  // Bulk product generator prompt
  server.prompt(
    'bulk-product-generator',
    'Generate multiple product variants from a single design',
    {
      designId: z.string().describe('The uploaded design image ID'),
      productTypes: z.string().describe('Comma-separated list of product types to create (e.g., "t-shirt, hoodie, mug")'),
      basePrice: z.string().describe('Base price in dollars (e.g., "19.99")'),
      namePattern: z.string().describe('Pattern for product names (e.g., "{design} - {type}")')
    },
    async ({ designId, productTypes, basePrice, namePattern }) => {
      // Parse the comma-separated product types
      const productTypesList = productTypes.split(',').map(s => s.trim()).filter(s => s.length > 0);
      
      // Parse the price
      const priceNumber = parseFloat(basePrice);
      const formattedPrice = isNaN(priceNumber) ? basePrice : `$${priceNumber.toFixed(2)}`;
      
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I need to create multiple products using design ID: ${designId}

Product types to create: ${productTypesList.join(', ')}
Base price: ${formattedPrice}
Naming pattern: ${namePattern}

Please:
1. Create a product for each type listed
2. Apply the design to the main print area
3. Enable popular sizes and colors
4. Set pricing based on the base price (adjust for product cost)
5. Use consistent naming following the pattern
6. Provide a summary of all created products

Optimize for efficiency while maintaining quality settings.`
          }
        }]
      };
    }
  );

  // Design upload assistant prompt
  server.prompt(
    'design-upload-assistant',
    'Help prepare and upload designs with optimal settings',
    {
      designType: z.string().describe('Type of design (logo, pattern, illustration, photo)'),
      intendedProducts: z.string().describe('Comma-separated list of products this design will be used on (e.g., "t-shirt, mug, hoodie")'),
      hasTransparency: z.string().describe('Whether the design needs transparency (yes/no)'),
      currentFormat: z.string().optional().describe('Current file format if known')
    },
    async ({ designType, intendedProducts, hasTransparency, currentFormat }) => {
      // Parse the comma-separated products list
      const productsList = intendedProducts.split(',').map(s => s.trim()).filter(s => s.length > 0);
      
      // Parse the transparency boolean
      const needsTransparency = hasTransparency.toLowerCase() === 'yes' || hasTransparency.toLowerCase() === 'true';
      
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `I need help uploading a ${designType} design for Printify.

Intended products: ${productsList.join(', ')}
Needs transparency: ${needsTransparency ? 'Yes' : 'No'}
${currentFormat ? `Current format: ${currentFormat}` : ''}

Please help me:
1. Verify the design meets requirements (DPI, dimensions, format)
2. Explain any necessary preparations or conversions
3. Upload the design with optimal settings
4. Provide placement recommendations for each product type
5. Suggest any design adjustments for better print quality

Include specific technical requirements and best practices.`
          }
        }]
      };
    }
  );

  // Product description writer prompt
  server.prompt(
    'product-description-writer',
    'Generate SEO-optimized product descriptions',
    {
      productName: z.string().describe('Name of the product'),
      targetKeywords: z.string().describe('Comma-separated list of SEO keywords to include (e.g., "vintage, retro, graphic tee")'),
      tone: z.string().describe('Writing tone (professional, casual, playful, luxury)'),
      features: z.string().describe('Comma-separated list of key product features to highlight (e.g., "soft cotton, eco-friendly, unisex fit")'),
      idealCustomer: z.string().optional().describe('Description of ideal customer')
    },
    async ({ productName, targetKeywords, tone, features, idealCustomer }) => {
      // Parse the comma-separated keywords and features
      const keywordsList = targetKeywords.split(',').map(s => s.trim()).filter(s => s.length > 0);
      const featuresList = features.split(',').map(s => s.trim()).filter(s => s.length > 0);
      
      return {
        messages: [{
          role: 'user',
          content: {
            type: 'text',
            text: `Write an SEO-optimized product description for: ${productName}

Target keywords: ${keywordsList.join(', ')}
Tone: ${tone}
Key features: ${featuresList.join(', ')}
${idealCustomer ? `Ideal customer: ${idealCustomer}` : ''}

Create:
1. A compelling title (50-60 characters)
2. A short description (150-160 characters) 
3. A detailed description (300-500 words)
4. 5-7 relevant tags
5. Key selling points in bullet format

Naturally incorporate keywords while maintaining readability and conversion focus.`
          }
        }]
      };
    }
  );

  // ===== RESOURCES =====

  // Design guidelines resource
  server.resource(
    'design-guidelines',
    'printify://guidelines/design-requirements',
    { 
      mimeType: 'application/json',
      description: 'Comprehensive design requirements for all Printify products'
    },
    async () => {
      const guidelines = {
        general: {
          dpi: 300,
          colorMode: 'RGB',
          recommendedFormats: ['PNG', 'JPG'],
          maxFileSize: '25MB'
        },
        products: {
          tshirt: {
            printArea: { width: 4500, height: 5400 },
            safeZone: '0.125 inches from edges',
            placement: 'Center chest, 3-4 inches from collar'
          },
          mug: {
            printArea: { width: 2700, height: 1200 },
            safeZone: '0.25 inches from edges',
            wraparound: true
          },
          hoodie: {
            printArea: { width: 4500, height: 5400 },
            pocketPrint: { width: 1200, height: 1200 },
            safeZone: '0.125 inches from edges'
          },
          poster: {
            printArea: 'Full bleed supported',
            bleed: '0.125 inches',
            safeZone: '0.25 inches for text'
          }
        },
        tips: [
          'Use PNG for designs with transparency',
          'Ensure text is converted to outlines',
          'Check design at 100% size before upload',
          'Avoid very thin lines (minimum 2pt)',
          'Test print colors may vary from screen'
        ]
      };
      
      return {
        contents: [{
          uri: 'printify://guidelines/design-requirements',
          text: JSON.stringify(guidelines, null, 2)
        }]
      };
    }
  );

  // Size charts resource
  server.resource(
    'size-charts',
    'printify://reference/size-charts',
    { 
      mimeType: 'application/json',
      description: 'Standard size charts for apparel products'
    },
    async () => {
      const sizeCharts = {
        unisexTShirt: {
          units: 'inches',
          sizes: {
            S: { chest: '34-36', length: 28 },
            M: { chest: '38-40', length: 29 },
            L: { chest: '42-44', length: 30 },
            XL: { chest: '46-48', length: 31 },
            '2XL': { chest: '50-52', length: 32 },
            '3XL': { chest: '54-56', length: 33 }
          }
        },
        womensTShirt: {
          units: 'inches',
          sizes: {
            S: { chest: '30-32', length: 25.5 },
            M: { chest: '32-34', length: 26 },
            L: { chest: '36-38', length: 27 },
            XL: { chest: '40-42', length: 28 }
          }
        },
        hoodie: {
          units: 'inches', 
          sizes: {
            S: { chest: '38-40', length: 27 },
            M: { chest: '42-44', length: 28 },
            L: { chest: '46-48', length: 29 },
            XL: { chest: '50-52', length: 30 },
            '2XL': { chest: '54-56', length: 31 }
          }
        }
      };
      
      return {
        contents: [{
          uri: 'printify://reference/size-charts',
          text: JSON.stringify(sizeCharts, null, 2)
        }]
      };
    }
  );

  // Pricing calculator resource
  server.resource(
    'pricing-calculator',
    'printify://tools/pricing-guide',
    { 
      mimeType: 'application/json',
      description: 'Pricing strategies and profit margin calculator'
    },
    async () => {
      const pricingGuide = {
        strategies: {
          keystone: {
            description: 'Double the total cost',
            formula: 'Retail Price = (Base Cost + Shipping) × 2',
            profitMargin: '50%'
          },
          competitive: {
            description: 'Market-based pricing',
            formula: 'Retail Price = Average Market Price',
            profitMargin: 'Varies (typically 30-40%)'
          },
          premium: {
            description: 'High-end positioning',
            formula: 'Retail Price = (Base Cost + Shipping) × 2.5-3',
            profitMargin: '60-70%'
          }
        },
        calculations: {
          profitMargin: '(Retail Price - Total Cost) / Retail Price × 100',
          breakEven: 'Fixed Costs / (Retail Price - Variable Cost)',
          recommendedMinimum: '30% profit margin'
        },
        tips: [
          'Consider shipping costs in your pricing',
          'Account for marketplace fees (Etsy, Shopify)',
          'Test different price points',
          'Bundle products for higher average order value',
          'Offer volume discounts strategically'
        ]
      };
      
      return {
        contents: [{
          uri: 'printify://tools/pricing-guide',
          text: JSON.stringify(pricingGuide, null, 2)
        }]
      };
    }
  );

  // Blueprint catalog resource
  server.resource(
    'blueprint-catalog',
    'printify://catalog/popular-blueprints',
    { 
      mimeType: 'application/json',
      description: 'Popular Printify product blueprints with recommendations'
    },
    async () => {
      const blueprintCatalog = {
        apparel: {
          tshirts: [
            {
              id: 12,
              name: 'Unisex Cotton T-Shirt',
              popularity: 'Very High',
              priceRange: '$8-12',
              bestFor: 'General audience, comfortable everyday wear',
              providers: ['Monster Digital', 'Print Geek', 'FYBY']
            },
            {
              id: 281,
              name: 'Unisex Cut & Sew Tee (AOP)',
              popularity: 'High',
              priceRange: '$15-22',
              bestFor: 'All-over prints, patterns, artistic designs',
              providers: ['Subliminator', 'Print Your Cause']
            }
          ],
          hoodies: [
            {
              id: 85,
              name: 'Unisex Heavy Blend Hoodie',
              popularity: 'Very High',
              priceRange: '$25-35',
              bestFor: 'Cold weather, casual streetwear',
              providers: ['Monster Digital', 'SwiftPOD']
            }
          ],
          longsleeves: [
            {
              id: 428,
              name: 'Unisex Long Sleeve Tee',
              popularity: 'Medium',
              priceRange: '$12-18',
              bestFor: 'Cooler weather, professional casual',
              providers: ['Monster Digital', 'FYBY']
            }
          ]
        },
        accessories: {
          mugs: [
            {
              id: 19,
              name: 'White Glossy Mug',
              popularity: 'Very High',
              priceRange: '$10-15',
              bestFor: 'Gifts, office use, simple designs',
              providers: ['District Photo', 'Print Geek']
            }
          ],
          toteBags: [
            {
              id: 517,
              name: 'Canvas Tote Bag',
              popularity: 'High',
              priceRange: '$12-18',
              bestFor: 'Eco-friendly shoppers, minimalist designs',
              providers: ['Bags of Love USA', 'Print Logistic']
            }
          ],
          phoneCases: [
            {
              id: 302,
              name: 'Clear Case for iPhone®',
              popularity: 'Medium',
              priceRange: '$15-20',
              bestFor: 'Tech accessories, personalized gifts',
              providers: ['Prisma', 'Case Escape']
            }
          ]
        },
        homeDecor: {
          posters: [
            {
              id: 1,
              name: 'Posters',
              popularity: 'High',
              priceRange: '$10-25',
              bestFor: 'Wall art, photography, illustrations',
              providers: ['Prodigi', 'Printify']
            }
          ],
          canvases: [
            {
              id: 30,
              name: 'Canvas Gallery Wraps',
              popularity: 'Medium',
              priceRange: '$25-50',
              bestFor: 'Premium wall art, photography',
              providers: ['Dream Junction', 'Prodigi']
            }
          ]
        },
        seasonal: {
          ornaments: {
            availability: 'September-December',
            popularBlueprints: [447, 632, 741]
          },
          beachTowels: {
            availability: 'March-August',
            popularBlueprints: [559, 612]
          }
        }
      };
      
      return {
        contents: [{
          uri: 'printify://catalog/popular-blueprints',
          text: JSON.stringify(blueprintCatalog, null, 2)
        }]
      };
    }
  );

  // API best practices resource
  server.resource(
    'api-best-practices',
    'printify://guides/api-best-practices',
    { 
      mimeType: 'application/json',
      description: 'Best practices for using the Printify API efficiently'
    },
    async () => {
      const bestPractices = {
        rateLimits: {
          standard: '120 requests per minute',
          burst: 'Up to 10 concurrent requests',
          recommendation: 'Implement exponential backoff on 429 errors'
        },
        efficiency: {
          batching: [
            'Create multiple variants in a single product creation',
            'Use bulk operations when available',
            'Cache blueprint and provider data locally'
          ],
          pagination: [
            'Use limit parameter (max 100)',
            'Process results in parallel when possible',
            'Store cursor for resumable operations'
          ]
        },
        imageOptimization: {
          upload: [
            'Compress images before upload (85% JPEG quality)',
            'Use appropriate dimensions for product type',
            'Upload once, reuse image ID for multiple products'
          ],
          formats: {
            transparent: 'PNG (for logos, text)',
            photos: 'JPEG (smaller file size)',
            vectors: 'Convert to high-res PNG first'
          }
        },
        errorHandling: {
          common: {
            401: 'Check API key validity',
            404: 'Verify resource IDs',
            422: 'Validate request payload',
            429: 'Implement rate limit backoff',
            500: 'Retry with exponential backoff'
          }
        },
        webhooks: {
          events: [
            'product.created',
            'product.updated', 
            'product.deleted',
            'order.created',
            'order.shipped'
          ],
          tip: 'Use webhooks instead of polling for real-time updates'
        }
      };
      
      return {
        contents: [{
          uri: 'printify://guides/api-best-practices',
          text: JSON.stringify(bestPractices, null, 2)
        }]
      };
    }
  );

    return server;
  } catch (error) {
    console.error('Error creating MCP server:', error);
    throw new Error(`Failed to create MCP server: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
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
    
    // Session recovery: Re-initialize Printify client if shop ID is missing
    if (!session.printifyClient.shopId) {
      console.log('Session missing shop ID, attempting recovery...');
      try {
        await session.printifyClient.initialize();
        console.log('Session recovered successfully');
      } catch (initError) {
        console.error('Failed to recover session:', initError);
        return res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Session recovery failed. Please re-register.',
          },
          id: null,
        });
      }
    }
    
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

// Test connection endpoint - validates API key without creating a session
app.post('/api/test-connection', async (req, res) => {
  const { printifyApiKey } = req.body;
  
  if (!printifyApiKey) {
    return res.status(400).json({ error: 'Printify API key is required' });
  }
  
  try {
    // Test the API key by initializing the client
    console.log('Testing API key connection...');
    const printifyClient = new PrintifyAPI(printifyApiKey);
    
    const shops = await printifyClient.initialize();
    
    res.json({
      success: true,
      shops: shops.map(shop => ({
        id: shop.id,
        title: shop.title,
        sales_channel: shop.sales_channel
      })),
      message: 'Connection successful'
    });
  } catch (error: any) {
    console.error('Test connection failed:', error);
    res.status(400).json({ 
      error: 'Failed to connect to Printify',
      details: error.message 
    });
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

// Health check endpoint with enhanced monitoring
app.get('/health', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeSessions: userSessions.size,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME || 'local',
      debugMode: process.env.PRINTIFY_DEBUG === 'true'
    },
    features: {
      printifyEnabled: true,
      replicateEnabled: !!process.env.REPLICATE_API_TOKEN,
      cacheEnabled: true
    }
  };
  
  res.json(health);
});

// Metrics endpoint for monitoring
app.get('/metrics', (req, res) => {
  const now = Date.now();
  const sessionMetrics = Array.from(userSessions.values()).map(session => ({
    hasReplicate: !!session.replicateClient,
    shopId: session.shopId,
    lastAccessedAgo: Math.floor((now - session.lastAccessed) / 1000) // seconds ago
  }));
  
  const activeInLast5Min = sessionMetrics.filter(s => s.lastAccessedAgo < 300).length;
  const activeInLast1Hour = sessionMetrics.filter(s => s.lastAccessedAgo < 3600).length;
  
  res.json({
    server: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      platform: process.platform,
      environment: process.env.NODE_ENV || 'development',
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT_NAME
    },
    sessions: {
      total: userSessions.size,
      activeInLast5Min,
      activeInLast1Hour,
      withReplicate: sessionMetrics.filter(s => s.hasReplicate).length
    },
    deployment: {
      baseUrl: getBaseUrl(),
      port: PORT,
      corsEnabled: true,
      version: '1.0.0'
    },
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

// Debug environment variables for Railway deployment
console.log('=== Railway Deployment Environment ===');
console.log('NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('PORT:', process.env.PORT || 'not set (default: 3000)');
console.log('BASE_URL:', process.env.BASE_URL || 'not set');
console.log('--- Railway Variables ---');
console.log('RAILWAY_PUBLIC_DOMAIN:', process.env.RAILWAY_PUBLIC_DOMAIN || 'not set');
console.log('RAILWAY_STATIC_URL:', process.env.RAILWAY_STATIC_URL || 'not set');
console.log('RAILWAY_ENVIRONMENT_NAME:', process.env.RAILWAY_ENVIRONMENT_NAME || 'not set');
console.log('RAILWAY_SERVICE_NAME:', process.env.RAILWAY_SERVICE_NAME || 'not set');
console.log('RAILWAY_PROJECT_ID:', process.env.RAILWAY_PROJECT_ID || 'not set');
console.log('RAILWAY_DEPLOYMENT_ID:', process.env.RAILWAY_DEPLOYMENT_ID || 'not set');
console.log('--- All Available Env Vars ---');
console.log('Available env vars:', Object.keys(process.env).filter(k => 
  !k.includes('SECRET') && 
  !k.includes('TOKEN') && 
  !k.includes('PASSWORD') &&
  !k.includes('KEY') &&
  !k.includes('API')
).sort());
console.log('======================================');

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
