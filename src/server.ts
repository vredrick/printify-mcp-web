import express from 'express';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PrintifyAPI, PrintifyErrorCode, ResponseFormatter } from './printify-api.js';
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
        x: z.number().optional().default(0.5).describe("Horizontal position (0-1, default: 0.5 for center)"),
        y: z.number().optional().default(0.5).describe("Vertical position (0-1, default: 0.5 for center)"),
        scale: z.number().optional().default(1).describe("Scale factor (0.5-2, default: 1)"),
        angle: z.number().optional().default(0).describe("Rotation angle in degrees (default: 0)")
      })).optional().describe("Design placement on product with positioning")
    },
    async (params) => {
      try {
        // Get blueprint for additional context in response
        let blueprint;
        try {
          blueprint = await session.printifyClient.getBlueprint(params.blueprintId.toString());
        } catch (error) {
          // Don't fail if we can't get blueprint details
        }
        
        const product = await session.printifyClient.createProduct(params);
        const formattedResponse = ResponseFormatter.formatProductCreated(product, blueprint);
        
        return {
          content: [{
            type: "text",
            text: formattedResponse
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, 'creating product');
        
        let troubleshootingGuidance = `\n🔧 Pre-creation Validation:\n`;
        troubleshootingGuidance += `• Use validate-product-config to check all parameters before creation\n`;
        troubleshootingGuidance += `• Use validate-blueprint ${params.blueprintId} to verify blueprint\n`;
        troubleshootingGuidance += `• Use validate-variants ${params.blueprintId} ${params.printProviderId} to check variants\n`;
        troubleshootingGuidance += `• Ensure images are uploaded successfully with upload-image\n`;
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError + troubleshootingGuidance
          }]
        };
      }
    }
  );

  // Simplified product creation tool with improved validation and error recovery
  server.tool(
    "create-product-simple",
    {
      title: z.string().describe("Product title"),
      description: z.string().optional().default("").describe("Product description"),
      blueprintId: z.number().describe("Blueprint ID (use get-popular-blueprints for common IDs)"),
      imageId: z.string().describe("Image ID from upload-image"),
      profitMargin: z.string().optional().default("50%").describe("Profit margin (e.g., '50%' or '100%')"),
      includeColors: z.string().optional().default("white,black").describe("Comma-separated colors to include"),
      includeSizes: z.string().optional().default("M,L,XL,2XL").describe("Comma-separated sizes to include")
    },
    async ({ title, description, blueprintId, imageId, profitMargin, includeColors, includeSizes }) => {
      try {
        // STEP 1: Enhanced pre-validation
        const validationErrors: string[] = [];
        const warnings: string[] = [];
        
        // Title validation
        if (!title || title.trim().length < 3) {
          validationErrors.push("Title must be at least 3 characters long");
        } else if (title.trim().length > 100) {
          warnings.push("Title is very long (>100 chars) - consider shortening for better display");
        }
        
        // Image ID validation
        if (!imageId || imageId.trim().length === 0) {
          validationErrors.push("Image ID is required - use upload-image first");
        } else if (!imageId.match(/^[a-zA-Z0-9]{24}$/)) {
          warnings.push(`Image ID format looks unusual: ${imageId} - ensure it's from upload-image`);
        }
        
        // Blueprint ID validation
        if (!blueprintId || blueprintId <= 0) {
          validationErrors.push("Invalid blueprint ID - must be a positive number");
        }
        
        // Color/size validation
        const colorList = includeColors.toLowerCase().split(',').map(c => c.trim()).filter(c => c.length > 0);
        const sizeList = includeSizes.toUpperCase().split(',').map(s => s.trim()).filter(s => s.length > 0);
        
        if (colorList.length === 0) {
          warnings.push("No colors specified - will try to match any color");
        } else if (colorList.length > 10) {
          warnings.push("Many colors requested - this may limit available variants");
        }
        
        if (sizeList.length === 0) {
          warnings.push("No sizes specified - will try to match any size");
        }
        
        // Profit margin validation
        const marginMatch = profitMargin.match(/^(\d+(?:\.\d+)?)\s*%?$/);
        if (!marginMatch) {
          validationErrors.push("Invalid profit margin format - use '50%' or '0.5'");
        } else {
          const marginValue = parseFloat(marginMatch[1]);
          if (marginValue < 10) {
            warnings.push("Low profit margin (<10%) - consider increasing for sustainability");
          } else if (marginValue > 200) {
            warnings.push("Very high profit margin (>200%) - may affect competitiveness");
          }
        }
        
        if (validationErrors.length > 0) {
          throw new Error(
            `❌ Validation failed\n\n` +
            `🚫 Errors:\n${validationErrors.map(e => `• ${e}`).join('\n')}\n\n` +
            `💡 Quick fixes:\n` +
            `• Use get-popular-blueprints for valid blueprint IDs\n` +
            `• Upload an image first with upload-image\n` +
            `• Example: title='My Product' blueprintId=77 imageId='...' colors='white,black'`
          );
        }
        
        // Log warnings but don't fail
        if (warnings.length > 0 && process.env.PRINTIFY_DEBUG === 'true') {
          console.log(`[DEBUG] Warnings: ${warnings.join('; ')}`);
        }
        
        // Debug logging function
        const debugLog = (message: string) => {
          if (process.env.PRINTIFY_DEBUG === 'true') {
            console.log(`[DEBUG] create-product-simple: ${message}`);
          }
        };
        
        debugLog(`Starting product creation - Title: "${title}", Blueprint: ${blueprintId}, Image: ${imageId}`);
        
        // STEP 2: Validate blueprint with error recovery
        let blueprint;
        try {
          debugLog(`Validating blueprint ${blueprintId}...`);
          blueprint = await session.printifyClient.getBlueprint(blueprintId.toString());
          if (!blueprint) {
            throw new Error(`Blueprint ${blueprintId} not found`);
          }
          debugLog(`Blueprint validated: ${blueprint.title || 'Unknown'}`);
        } catch (error: any) {
          debugLog(`Blueprint validation failed: ${error.message}`);
          throw new Error(`Blueprint validation failed: ${error.message}\n• Use get-popular-blueprints to find valid blueprint IDs`);
        }
        
        // STEP 3: Get print providers with fallback
        let providers;
        try {
          debugLog(`Getting print providers for blueprint ${blueprintId}...`);
          providers = await session.printifyClient.getPrintProviders(blueprintId.toString());
          if (!providers || providers.length === 0) {
            throw new Error(`No print providers available for blueprint ${blueprintId} (${blueprint.title})`);
          }
          debugLog(`Found ${providers.length} print providers`);
        } catch (error: any) {
          debugLog(`Print provider lookup failed: ${error.message}`);
          throw new Error(`Print provider lookup failed: ${error.message}\n• This blueprint may not be available in your region`);
        }
        
        const printProviderId = providers[0].id;
        debugLog(`Selected print provider: ${providers[0].title || 'Unknown'} (ID: ${printProviderId})`)
        
        // STEP 4: Get and validate variants
        let variantsData;
        try {
          variantsData = await session.printifyClient.getVariants(
            blueprintId.toString(), 
            printProviderId.toString()
          );
          if (!variantsData || !variantsData.variants || variantsData.variants.length === 0) {
            throw new Error(`No variants available for blueprint ${blueprintId} with provider ${printProviderId}`);
          }
        } catch (error: any) {
          throw new Error(`Variant lookup failed: ${error.message}\n• Try a different blueprint or check provider availability`);
        }
        
        // STEP 5: Enhanced variant filtering with improved matching
        const requestedColors = includeColors.toLowerCase().split(',').map(c => c.trim()).filter(c => c.length > 0);
        const requestedSizes = includeSizes.toUpperCase().split(',').map(s => s.trim()).filter(s => s.length > 0);
        
        const allVariants = variantsData.variants || [];
        
        debugLog(`Total variants available: ${allVariants.length}`);
        debugLog(`Requested colors: ${requestedColors.join(', ')}`);
        debugLog(`Requested sizes: ${requestedSizes.join(', ')}`);
        
        // Enhanced color matching with fuzzy logic
        const enhancedColorMatch = (variantTitle: string, requestedColor: string) => {
          const titleLower = variantTitle.toLowerCase();
          const colorLower = requestedColor.toLowerCase();
          
          // Direct match
          if (titleLower.includes(colorLower)) return true;
          
          // Handle common variations
          const colorVariations: {[key: string]: string[]} = {
            'white': ['white', 'solid white', 'natural', 'cream'],
            'black': ['black', 'solid black', 'dark'],
            'gray': ['gray', 'grey', 'heather gray', 'heather grey', 'charcoal'],
            'red': ['red', 'cardinal', 'scarlet', 'crimson'],
            'blue': ['blue', 'navy', 'royal blue', 'sapphire'],
            'green': ['green', 'forest', 'olive', 'emerald']
          };
          
          // Check if requested color has variations
          const variations = colorVariations[colorLower] || [];
          return variations.some(variant => titleLower.includes(variant));
        };
        
        // Enhanced size matching with better boundaries
        const enhancedSizeMatch = (variantTitle: string, requestedSize: string) => {
          // Extract size from variant title more reliably
          // Common patterns: "Color / Size", "Color - Size", "Color Size"
          const sizePatterns = [
            new RegExp(`[/\\-\\s]\\s*${requestedSize}\\s*$`, 'i'), // End of string
            new RegExp(`[/\\-\\s]\\s*${requestedSize}\\s*[/\\-\\s]`, 'i'), // Middle
            new RegExp(`^${requestedSize}\\s*[/\\-\\s]`, 'i'), // Start
            new RegExp(`\\b${requestedSize}\\b`, 'i') // Word boundary
          ];
          
          return sizePatterns.some(pattern => pattern.test(variantTitle));
        };
        
        // Filter variants with enhanced matching
        let filteredVariants = allVariants.filter((v: any) => {
          const title = v.title;
          
          const hasRequestedColor = requestedColors.length === 0 || 
            requestedColors.some(color => enhancedColorMatch(title, color));
          
          const hasRequestedSize = requestedSizes.length === 0 ||
            requestedSizes.some(size => enhancedSizeMatch(title, size));
          
          if (hasRequestedColor && hasRequestedSize) {
            debugLog(`Matched variant: ${title}`);
          }
          
          return hasRequestedColor && hasRequestedSize;
        });
        
        debugLog(`Initial filter matched ${filteredVariants.length} variants`);
        
        // Progressive fallback strategy
        if (filteredVariants.length === 0) {
          debugLog('No exact matches found, trying fallback strategies...');
          
          // Fallback 1: Try colors only (ignore sizes)
          if (requestedColors.length > 0) {
            filteredVariants = allVariants.filter((v: any) => 
              requestedColors.some(color => enhancedColorMatch(v.title, color))
            );
            debugLog(`Color-only fallback matched ${filteredVariants.length} variants`);
          }
          
          // Fallback 2: Try common color/size combinations
          if (filteredVariants.length === 0) {
            const commonColors = ['white', 'black', 'gray', 'navy'];
            const commonSizes = ['M', 'L', 'XL'];
            
            filteredVariants = allVariants.filter((v: any) => {
              const title = v.title.toLowerCase();
              const hasCommonColor = commonColors.some(color => title.includes(color));
              const hasCommonSize = commonSizes.some(size => enhancedSizeMatch(v.title, size));
              return hasCommonColor && hasCommonSize;
            });
            debugLog(`Common combo fallback matched ${filteredVariants.length} variants`);
          }
          
          // Fallback 3: Use most popular variants (first few)
          if (filteredVariants.length === 0) {
            const fallbackCount = Math.min(5, allVariants.length);
            filteredVariants = allVariants.slice(0, fallbackCount);
            debugLog(`Using first ${fallbackCount} variants as final fallback`);
          }
        }
        
        const variants = filteredVariants.map((v: any) => {
          const pricing = session.printifyClient.calculatePricing(v.cost, profitMargin);
          return {
            variantId: v.id,
            price: pricing.price,
            isEnabled: true
          };
        });

        if (variants.length === 0) {
          // Provide detailed error with available options
          const sampleVariants = allVariants.slice(0, 5).map((v: any) => v.title);
          const availableColors = new Set<string>();
          const availableSizes = new Set<string>();
          
          // Extract available colors and sizes for better guidance
          allVariants.forEach((v: any) => {
            const title = v.title;
            // Extract color (usually before / or -)
            const colorMatch = title.match(/^([^\/\-]+?)(?:\s*[\/\-]|$)/);
            if (colorMatch) availableColors.add(colorMatch[1].trim());
            
            // Extract size (usually after / or -)
            const sizeMatch = title.match(/[\/\-]\s*([XSMLXL0-9]+)$/i);
            if (sizeMatch) availableSizes.add(sizeMatch[1].trim().toUpperCase());
          });
          
          throw new Error(
            `❌ No variants could be created for blueprint ${blueprintId}\n\n` +
            `📋 What went wrong:\n` +
            `• Requested colors: ${requestedColors.join(', ') || 'none'}\n` +
            `• Requested sizes: ${requestedSizes.join(', ') || 'none'}\n` +
            `• No matching variants found\n\n` +
            `✅ Available options:\n` +
            `• Colors: ${Array.from(availableColors).slice(0, 5).join(', ')}${availableColors.size > 5 ? '...' : ''}\n` +
            `• Sizes: ${Array.from(availableSizes).slice(0, 8).join(', ')}${availableSizes.size > 8 ? '...' : ''}\n` +
            `• Sample variants: ${sampleVariants.join(', ')}${allVariants.length > 5 ? '...' : ''}\n\n` +
            `💡 Solutions:\n` +
            `1. Use common options: colors='white,black' sizes='M,L,XL'\n` +
            `2. Check exact options: get-variants ${blueprintId} ${printProviderId}\n` +
            `3. Validate first: validate-variants ${blueprintId} ${printProviderId}\n` +
            `4. Use create-product for full control over variant selection`
          );
        }

        // STEP 6: Create product with error recovery
        const productData = {
          title: title.trim(),
          description: description.trim(),
          blueprintId,
          printProviderId,
          variants,
          printAreas: {
            front: {
              position: 'front',
              imageId,
              x: 0.5,
              y: 0.5,
              scale: 1,
              angle: 0
            }
          }
        };

        let product;
        try {
          debugLog(`Creating product with ${variants.length} variants`);
          product = await session.printifyClient.createProduct(productData);
        } catch (error: any) {
          // Enhanced error message with more context
          const errorMessage = error.message || 'Unknown error';
          
          // Check for common error patterns
          if (errorMessage.toLowerCase().includes('validation')) {
            throw new Error(
              `❌ Product creation validation failed\n\n` +
              `📋 Error details: ${errorMessage}\n\n` +
              `🔍 Common causes:\n` +
              `• Invalid image ID: ${imageId}\n` +
              `• Blueprint/provider mismatch\n` +
              `• Variant configuration issues\n\n` +
              `✅ Debug steps:\n` +
              `1. Verify image upload: Check that upload-image returned ${imageId}\n` +
              `2. Validate configuration: validate-product-config ${blueprintId} ${printProviderId} [${variants.map(v => v.variantId).slice(0,3).join(',')}...]\n` +
              `3. Try with minimal options: colors='white' sizes='L'\n` +
              `4. Enable debug mode: Set PRINTIFY_DEBUG=true for detailed logs`
            );
          } else if (errorMessage.toLowerCase().includes('image')) {
            throw new Error(
              `❌ Image-related error during product creation\n\n` +
              `📋 Error: ${errorMessage}\n\n` +
              `🖼️ Image ID: ${imageId}\n\n` +
              `✅ Solutions:\n` +
              `• Ensure image was uploaded successfully\n` +
              `• Check image format (PNG/JPG recommended)\n` +
              `• Verify image dimensions meet blueprint requirements\n` +
              `• Re-upload image if needed`
            );
          } else {
            throw new Error(
              `❌ Product creation failed\n\n` +
              `📋 Error: ${errorMessage}\n\n` +
              `📊 Attempted configuration:\n` +
              `• Blueprint: ${blueprintId}\n` +
              `• Provider: ${printProviderId}\n` +
              `• Variants: ${variants.length} selected\n` +
              `• Image: ${imageId}\n\n` +
              `✅ Troubleshooting:\n` +
              `• Try validate-blueprint ${blueprintId} first\n` +
              `• Check API status and connection\n` +
              `• Use create-product for more control\n` +
              `• Contact support if issue persists`
            );
          }
        }
        
        // Format success response using ResponseFormatter
        const formattedResponse = ResponseFormatter.formatProductCreated(product, blueprint);
        
        return {
          content: [{
            type: "text",
            text: formattedResponse + `\n\n📊 Creation Summary:\n` +
              `• Blueprint: ${blueprint.title} (ID: ${blueprintId})\n` +
              `• Variants: ${variants.length} enabled\n` +
              `• Profit margin: ${profitMargin}\n` +
              `• Filters applied: ${requestedColors.join(', ')} | ${requestedSizes.join(', ')}\n\n` +
              `✅ Next Steps:\n` +
              `• Use publish-product to make it available in your store\n` +
              `• Use get-product ${product.id} to view current status\n` +
              `• Use update-product to modify details if needed`
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, 'creating product (simple mode)');
        
        let troubleshootingSteps = `\n🔧 Troubleshooting Steps:\n`;
        troubleshootingSteps += `1. Validate blueprint: validate-blueprint ${blueprintId}\n`;
        troubleshootingSteps += `2. Check image: ensure upload-image returned valid ID\n`;
        troubleshootingSteps += `3. Test variants: validate-variants ${blueprintId}\n`;
        troubleshootingSteps += `4. Try simpler filters: colors='white,black' sizes='M,L,XL'\n`;
        troubleshootingSteps += `5. Use get-popular-blueprints for tested blueprint IDs\n`;
        
        let quickFixes = `\n🚀 Quick Fixes:\n`;
        quickFixes += `• Common working blueprint IDs: 5 (t-shirt), 19 (mug), 77 (hoodie)\n`;
        quickFixes += `• Reliable color options: white, black, gray, red, blue\n`;
        quickFixes += `• Standard sizes: S, M, L, XL, 2XL\n`;
        quickFixes += `• For complex needs, use create-product instead\n`;
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError + troubleshootingSteps + quickFixes
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
      type: z.string().optional().describe("Type: 'tshirt', 'hoodie', 'mug', 'totebag', 'poster', etc."),
      limit: z.number().optional().default(15).describe("Maximum number of results (default: 15)")
    },
    async ({ category, type, limit }) => {
      try {
        const blueprints = await session.printifyClient.searchBlueprints(category, type);
        const data = blueprints.data || [];
        
        // Create search header with context
        let searchHeader = '🔍 Blueprint Search Results\n';
        searchHeader += '═══════════════════════════\n\n';
        
        if (category && type) {
          searchHeader += `📂 Category: ${category} → ${type}\n`;
        } else if (category) {
          searchHeader += `📂 Category: ${category}\n`;
        } else if (type) {
          searchHeader += `🔎 Type: ${type}\n`;
        } else {
          searchHeader += `🌟 All Blueprints\n`;
        }
        
        searchHeader += `📊 Found: ${data.length} result${data.length !== 1 ? 's' : ''}\n\n`;
        
        // Handle empty results
        if (data.length === 0) {
          let suggestions = `💡 Try these alternatives:\n`;
          suggestions += `• Use get-popular-blueprints for commonly used products\n`;
          suggestions += `• Try broader categories: 'apparel', 'accessories', 'home'\n`;
          suggestions += `• Search for types: 'tshirt', 'hoodie', 'mug', 'poster', 'sticker'\n`;
          suggestions += `• Use get-blueprints to browse all available options\n`;
          
          return {
            content: [{
              type: "text",
              text: searchHeader + suggestions
            }]
          };
        }
        
        // Format results with pagination support
        const formattedResults = ResponseFormatter.formatBlueprintsList(
          data.slice(0, limit), 
          { includeDescription: true, maxItems: limit }
        );
        
        // Add response size warning if needed
        const responseWithWarning = ResponseFormatter.addResponseSizeWarning(formattedResults, data);
        
        // Add search-specific guidance
        let searchGuidance = `\n🎯 Refine Your Search:\n`;
        if (!category) searchGuidance += `• Add category filter: search-blueprints category='apparel'\n`;
        if (!type) searchGuidance += `• Add type filter: search-blueprints type='tshirt'\n`;
        if (data.length > limit) searchGuidance += `• Showing ${limit} of ${data.length} results. Reduce limit for faster loading.\n`;
        
        // Add size management guidance for large result sets
        let sizeGuidance = '';
        if (data.length > 30) {
          sizeGuidance = `\n📊 Large Result Set Detected:\n`;
          sizeGuidance += `• Consider using more specific filters to reduce results\n`;
          sizeGuidance += `• Use get-popular-blueprints for commonly used items\n`;
          sizeGuidance += `• Try smaller limit values for faster responses\n`;
        }
        
        // Add fallback information if relevant
        let fallbackInfo = '';
        if (blueprints._fallback) {
          fallbackInfo = `\n⚠️ Note: Using cached data. ${blueprints._message}\n`;
        }
        
        return {
          content: [{
            type: "text",
            text: searchHeader + responseWithWarning + searchGuidance + sizeGuidance + fallbackInfo
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, 'searching blueprints');
        
        let searchHelp = `\n🔍 Search Tips:\n`;
        searchHelp += `• Valid categories: 'apparel', 'accessories', 'home'\n`;
        searchHelp += `• Popular types: 'tshirt', 'hoodie', 'mug', 'totebag', 'poster', 'sticker'\n`;
        searchHelp += `• Use get-popular-blueprints for quick access to common products\n`;
        searchHelp += `• Try get-blueprints limit=5 for general browsing\n`;
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError + searchHelp
          }]
        };
      }
    }
  );

  // Get popular blueprints tool
  server.tool(
    "get-popular-blueprints",
    {
      category: z.string().optional().describe("Filter by category: 'apparel', 'accessories', or 'home' (optional)")
    },
    async ({ category }) => {
      try {
        const blueprints = await session.printifyClient.getPopularBlueprints();
        let data = blueprints.data || [];
        
        // Filter by category if specified
        if (category) {
          const categoryMap: {[key: string]: string[]} = {
            'apparel': ['t-shirt', 'tshirt', 'shirt', 'hoodie', 'tank', 'long sleeve'],
            'accessories': ['mug', 'bag', 'tote', 'sticker', 'phone case'],
            'home': ['poster', 'canvas', 'print', 'wall art', 'blanket', 'pillow']
          };
          
          const categoryTerms = categoryMap[category.toLowerCase()] || [];
          if (categoryTerms.length > 0) {
            data = data.filter((bp: any) => {
              const title = (bp.title || '').toLowerCase();
              return categoryTerms.some(term => title.includes(term));
            });
          }
        }
        
        // Create header
        let header = '⭐ Popular Blueprints\n';
        header += '═══════════════════\n\n';
        
        if (category) {
          header += `📂 Category: ${category}\n`;
          header += `📊 Found: ${data.length} popular ${category} product${data.length !== 1 ? 's' : ''}\n\n`;
        } else {
          header += `🚀 Most commonly used blueprints for quick product creation\n`;
          header += `📊 Total: ${data.length} blueprints\n\n`;
        }
        
        // Handle empty results
        if (data.length === 0) {
          let suggestions = `💡 No popular blueprints found`;
          if (category) {
            suggestions += ` in ${category} category`;
          }
          suggestions += `\n\nTry:\n`;
          suggestions += `• Remove category filter: get-popular-blueprints\n`;
          suggestions += `• Search by type: search-blueprints type='tshirt'\n`;
          suggestions += `• Browse all: get-blueprints limit=10\n`;
          
          return {
            content: [{
              type: "text",
              text: header + suggestions
            }]
          };
        }
        
        // Format using the blueprint formatter
        const formattedResults = ResponseFormatter.formatBlueprintsList(
          data,
          { includeDescription: true, maxItems: data.length }
        );
        
        // Add usage guidance specific to popular blueprints
        let usageGuidance = `\n🎯 Quick Start Guide:\n`;
        usageGuidance += `• These are the most reliable and commonly used blueprints\n`;
        usageGuidance += `• Use with create-product-simple for fastest product creation\n`;
        usageGuidance += `• All have good print provider availability and variant options\n`;
        
        if (!category) {
          usageGuidance += `• Filter by category: get-popular-blueprints category='apparel'\n`;
        }
        
        // Add fallback information if relevant
        let fallbackInfo = '';
        if (blueprints._fallback) {
          fallbackInfo = `\n⚠️ Note: Using cached data. ${blueprints._message}\n`;
        }
        
        return {
          content: [{
            type: "text",
            text: header + formattedResults + usageGuidance + fallbackInfo
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, 'retrieving popular blueprints');
        
        let quickHelp = `\n🚀 Alternative Options:\n`;
        quickHelp += `• Try get-blueprints limit=5 for general browsing\n`;
        quickHelp += `• Use search-blueprints category='apparel' for specific categories\n`;
        quickHelp += `• Check your internet connection and API key\n`;
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError + quickHelp
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

  // Get variant colors tool
  server.tool(
    "get-variant-colors",
    {
      blueprintId: z.string().describe("Blueprint ID"),
      printProviderId: z.string().describe("Print provider ID")
    },
    async ({ blueprintId, printProviderId }) => {
      try {
        const variants = await session.printifyClient.getVariants(blueprintId, printProviderId);
        
        // Extract unique colors from variant titles
        const colorSet = new Set<string>();
        const colorPatterns: string[] = [];
        
        variants.variants.forEach((v: any) => {
          // Extract color from title (usually before size or after /)
          const title = v.title;
          
          // Common patterns: "White / S", "Solid White / S", "White", etc.
          const match = title.match(/^([^\/]+?)(?:\s*\/|$)/);
          if (match) {
            const color = match[1].trim();
            colorSet.add(color);
          }
        });
        
        const colors = Array.from(colorSet).sort();
        
        return {
          content: [{
            type: "text",
            text: `Available colors for blueprint ${blueprintId}:
${colors.map(c => `• ${c}`).join('\n')}

Total: ${colors.length} colors

Use these exact color names when creating products or filtering variants.`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error getting variant colors: ${error.message}`
          }]
        };
      }
    }
  );

  // Get variant sizes tool
  server.tool(
    "get-variant-sizes",
    {
      blueprintId: z.string().describe("Blueprint ID"),
      printProviderId: z.string().describe("Print provider ID"),
      color: z.string().optional().describe("Filter sizes for specific color")
    },
    async ({ blueprintId, printProviderId, color }) => {
      try {
        const variants = await session.printifyClient.getVariants(blueprintId, printProviderId);
        
        // Extract sizes
        const sizeSet = new Set<string>();
        
        variants.variants.forEach((v: any) => {
          const title = v.title;
          
          // If color filter is provided, only process matching variants
          if (color && !title.toLowerCase().includes(color.toLowerCase())) {
            return;
          }
          
          // Extract size (usually after / or at the end)
          const sizeMatch = title.match(/\/\s*([^\/]+?)$/);
          if (sizeMatch) {
            sizeSet.add(sizeMatch[1].trim());
          } else {
            // Sometimes size is the whole title for simple products
            const parts = title.split(' ');
            const lastPart = parts[parts.length - 1];
            if (['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'].includes(lastPart)) {
              sizeSet.add(lastPart);
            }
          }
        });
        
        const sizes = Array.from(sizeSet).sort((a, b) => {
          const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'];
          return sizeOrder.indexOf(a) - sizeOrder.indexOf(b);
        });
        
        return {
          content: [{
            type: "text",
            text: `Available sizes for blueprint ${blueprintId}${color ? ` (color: ${color})` : ''}:
${sizes.map(s => `• ${s}`).join('\n')}

Total: ${sizes.length} sizes

Use these exact size names when creating products or filtering variants.`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error getting variant sizes: ${error.message}`
          }]
        };
      }
    }
  );

  // Validate product data tool
  server.tool(
    "validate-product-data",
    {
      blueprintId: z.number().describe("Blueprint ID"),
      printProviderId: z.number().describe("Print provider ID"),
      variantIds: z.array(z.number()).describe("Array of variant IDs to validate"),
      imageId: z.string().describe("Image ID to validate")
    },
    async ({ blueprintId, printProviderId, variantIds, imageId }) => {
      try {
        const issues: string[] = [];
        const suggestions: string[] = [];
        
        // Check if variants exist
        const variantsData = await session.printifyClient.getVariants(
          blueprintId.toString(),
          printProviderId.toString()
        );
        
        const availableVariantIds = variantsData.variants.map((v: any) => v.id);
        const invalidVariants = variantIds.filter(id => !availableVariantIds.includes(id));
        
        if (invalidVariants.length > 0) {
          issues.push(`Invalid variant IDs: ${invalidVariants.join(', ')}`);
          suggestions.push(`Available variant IDs: ${availableVariantIds.slice(0, 5).join(', ')}...`);
        }
        
        // Show sample variant for reference
        if (variantsData.variants.length > 0) {
          const sample = variantsData.variants[0];
          suggestions.push(`Sample variant: ID ${sample.id} = "${sample.title}" (cost: $${(sample.cost / 100).toFixed(2)})`);
        }
        
        const isValid = issues.length === 0;
        
        return {
          content: [{
            type: "text",
            text: `Validation result: ${isValid ? '✅ VALID' : '❌ INVALID'}

${issues.length > 0 ? 'Issues found:\n' + issues.map(i => `• ${i}`).join('\n') + '\n\n' : ''}
${suggestions.length > 0 ? 'Suggestions:\n' + suggestions.map(s => `• ${s}`).join('\n') : ''}

${isValid ? 'This product data should work with create-product.' : 'Fix the issues above before creating the product.'}`
          }]
        };
      } catch (error: any) {
        return {
          content: [{
            type: "text",
            text: `Error validating product data: ${error.message}`
          }]
        };
      }
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
      limit: z.number().optional().default(10).describe("Number of blueprints per page (default: 10, recommended: 5-15)"),
      compact: z.boolean().optional().default(false).describe("Show compact view without descriptions (default: false)")
    },
    async ({ page, limit, compact }) => {
      try {
        const blueprints = await session.printifyClient.getBlueprints(page, limit);
        
        // Handle fallback data with formatted response
        if (blueprints._fallback) {
          const fallbackMessage = `⚠️ Using cached blueprint data\n${blueprints._message}\n\n`;
          const formattedList = ResponseFormatter.formatBlueprintsList(
            blueprints.data || [], 
            { includeDescription: !compact, maxItems: limit }
          );
          
          return {
            content: [{
              type: "text",
              text: fallbackMessage + formattedList
            }]
          };
        }
        
        // Format live API data with pagination
        const formattedResponse = ResponseFormatter.formatWithPagination(
          blueprints.data || [],
          page,
          limit,
          (items) => ResponseFormatter.formatBlueprintsList(items, { includeDescription: !compact, maxItems: limit }),
          blueprints.total
        );
        
        // Add response size warning if needed
        const responseWithWarning = ResponseFormatter.addResponseSizeWarning(formattedResponse, blueprints);
        
        // Add size management guidance for large responses
        let sizeGuidance = '';
        if (blueprints.data && blueprints.data.length >= 20) {
          sizeGuidance = ResponseFormatter.getResponseSizeGuidance();
        }
        
        return {
          content: [{
            type: "text",
            text: responseWithWarning + sizeGuidance
          }]
        };
      } catch (error: any) {
        // Format error response
        const formattedError = ResponseFormatter.formatError(error, 'retrieving blueprints');
        
        // Add specific guidance for common issues
        let additionalGuidance = '';
        if (error.code === PrintifyErrorCode.TIMEOUT) {
          additionalGuidance = `\n🔄 Quick Solutions:\n• Try get-blueprints limit=5 for faster loading\n• Use get-popular-blueprints for commonly used items\n• Enable debug mode: PRINTIFY_DEBUG=true\n`;
        }
        
        return {
          content: [{
            type: "text",
            text: formattedError + additionalGuidance
          }]
        };
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
      try {
        const blueprint = await session.printifyClient.getBlueprint(blueprintId);
        const formattedResponse = ResponseFormatter.formatBlueprintDetails(blueprint);
        
        return {
          content: [{
            type: "text",
            text: formattedResponse
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, `retrieving blueprint ${blueprintId}`);
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError
          }]
        };
      }
    }
  );

  // Get print providers tool
  server.tool(
    "get-print-providers",
    {
      blueprintId: z.string().describe("Blueprint ID")
    },
    async ({ blueprintId }) => {
      try {
        const providers = await session.printifyClient.getPrintProviders(blueprintId);
        const formattedResponse = ResponseFormatter.formatPrintProviders(providers, blueprintId);
        
        return {
          content: [{
            type: "text",
            text: formattedResponse
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, `retrieving print providers for blueprint ${blueprintId}`);
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError
          }]
        };
      }
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
      try {
        const variantsData = await session.printifyClient.getVariants(blueprintId, printProviderId);
        const variants = variantsData.variants || [];
        const formattedResponse = ResponseFormatter.formatVariants(variants, blueprintId, printProviderId);
        
        return {
          content: [{
            type: "text",
            text: formattedResponse
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, `retrieving variants for blueprint ${blueprintId}, provider ${printProviderId}`);
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError
          }]
        };
      }
    }
  );

  // ===== VALIDATION TOOLS =====

  // Validate blueprint tool
  server.tool(
    "validate-blueprint",
    {
      blueprintId: z.string().describe("Blueprint ID to validate")
    },
    async ({ blueprintId }) => {
      try {
        // Get blueprint details
        const blueprint = await session.printifyClient.getBlueprint(blueprintId);
        
        // Get print providers for this blueprint
        const providers = await session.printifyClient.getPrintProviders(blueprintId);
        
        let output = `✅ Blueprint Validation: ${blueprintId}\n`;
        output += `═══════════════════════════════════\n\n`;
        output += `📋 Name: ${blueprint.title || 'Unknown'}\n`;
        output += `🏢 Brand: ${blueprint.brand || 'Unknown'}\n`;
        output += `🆔 ID: ${blueprint.id}\n`;
        output += `📄 Description: ${blueprint.description || 'No description'}\n\n`;
        
        output += `🖨️ Print Providers Available: ${providers?.length || 0}\n`;
        if (providers && providers.length > 0) {
          output += `   ⭐ Recommended: ${providers[0].title} (ID: ${providers[0].id})\n`;
          if (providers.length > 1) {
            output += `   📋 Alternatives: ${providers.slice(1).map((p: any) => `${p.title} (${p.id})`).join(', ')}\n`;
          }
        } else {
          output += `   ❌ No print providers available\n`;
        }
        
        output += `\n💡 Next Steps:\n`;
        if (providers && providers.length > 0) {
          output += `• Use validate-variants ${blueprintId} ${providers[0].id} to check available variants\n`;
          output += `• Use get-variants ${blueprintId} ${providers[0].id} to see all options\n`;
          output += `• This blueprint is ready for product creation\n`;
        } else {
          output += `• ❌ Cannot create products - no print providers available\n`;
          output += `• Try a different blueprint ID from get-popular-blueprints\n`;
        }
        
        return {
          content: [{
            type: "text",
            text: output
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, `validating blueprint ${blueprintId}`);
        
        let validationHelp = `\n🔍 Validation Tips:\n`;
        validationHelp += `• Ensure blueprint ID is correct (use get-popular-blueprints)\n`;
        validationHelp += `• Try get-blueprints to browse available options\n`;
        validationHelp += `• Check if the blueprint exists with get-blueprint ${blueprintId}\n`;
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError + validationHelp
          }]
        };
      }
    }
  );

  // Validate variants tool
  server.tool(
    "validate-variants",
    {
      blueprintId: z.string().describe("Blueprint ID"),
      printProviderId: z.string().describe("Print provider ID"),
      colors: z.string().optional().describe("Comma-separated colors to check (e.g., 'white,black')"),
      sizes: z.string().optional().describe("Comma-separated sizes to check (e.g., 'M,L,XL')")
    },
    async ({ blueprintId, printProviderId, colors, sizes }) => {
      try {
        // Get variants data
        const variantsData = await session.printifyClient.getVariants(blueprintId, printProviderId);
        const allVariants = variantsData.variants || [];
        
        let output = `✅ Variant Validation\n`;
        output += `═══════════════════\n\n`;
        output += `📋 Blueprint: ${blueprintId}\n`;
        output += `🖨️ Provider: ${printProviderId}\n`;
        output += `👕 Total variants available: ${allVariants.length}\n\n`;
        
        // If no filters specified, show summary
        if (!colors && !sizes) {
          // Group by color for summary
          const colorGroups = new Map<string, any[]>();
          allVariants.forEach((variant: any) => {
            const colorMatch = variant.title.match(/^([^\/]+)/);
            const color = colorMatch ? colorMatch[1].trim() : 'Unknown';
            if (!colorGroups.has(color)) colorGroups.set(color, []);
            colorGroups.get(color)!.push(variant);
          });
          
          output += `🎨 Available Colors (${colorGroups.size}):\n`;
          for (const [color, variants] of colorGroups) {
            const sampleSizes = variants.slice(0, 3).map((v: any) => {
              const sizeMatch = v.title.match(/\/\s*(.+)$/);
              return sizeMatch ? sizeMatch[1].trim() : 'One Size';
            });
            output += `  • ${color}: ${sampleSizes.join(', ')}${variants.length > 3 ? ' ...' : ''}\n`;
          }
          
          output += `\n💡 To validate specific options:\n`;
          output += `• validate-variants ${blueprintId} ${printProviderId} colors='white,black'\n`;
          output += `• validate-variants ${blueprintId} ${printProviderId} sizes='M,L,XL'\n`;
          output += `• validate-variants ${blueprintId} ${printProviderId} colors='white' sizes='M,L,XL'\n`;
          
          return {
            content: [{
              type: "text",
              text: output
            }]
          };
        }
        
        // Filter variants based on specified colors and sizes
        const requestedColors = colors ? colors.toLowerCase().split(',').map(c => c.trim()) : [];
        const requestedSizes = sizes ? sizes.toUpperCase().split(',').map(s => s.trim()) : [];
        
        const matchingVariants = allVariants.filter((variant: any) => {
          const title = variant.title;
          
          // Check color match
          let colorMatch = true;
          if (requestedColors.length > 0) {
            colorMatch = requestedColors.some(color => 
              title.toLowerCase().includes(color.toLowerCase())
            );
          }
          
          // Check size match
          let sizeMatch = true;
          if (requestedSizes.length > 0) {
            sizeMatch = requestedSizes.some(size => {
              const sizeRegex = new RegExp(`\\b${size}\\b`, 'i');
              return sizeRegex.test(title);
            });
          }
          
          return colorMatch && sizeMatch;
        });
        
        // Report validation results
        if (requestedColors.length > 0) {
          output += `🎨 Requested Colors: ${requestedColors.join(', ')}\n`;
        }
        if (requestedSizes.length > 0) {
          output += `📏 Requested Sizes: ${requestedSizes.join(', ')}\n`;
        }
        
        output += `\n🔍 Validation Results:\n`;
        output += `• Found ${matchingVariants.length} matching variants\n`;
        
        if (matchingVariants.length === 0) {
          output += `❌ No variants match your criteria\n\n`;
          output += `💡 Suggestions:\n`;
          
          // Analyze what's available
          const availableColors = [...new Set(allVariants.map((v: any) => {
            const match = v.title.match(/^([^\/]+)/);
            return match ? match[1].trim().toLowerCase() : '';
          }))].filter(c => c);
          
          const availableSizes = [...new Set(allVariants.map((v: any) => {
            const match = v.title.match(/\/\s*(.+)$/);
            return match ? match[1].trim().toUpperCase() : '';
          }))].filter(s => s);
          
          if (requestedColors.length > 0) {
            output += `• Available colors: ${availableColors.slice(0, 5).join(', ')}\n`;
          }
          if (requestedSizes.length > 0) {
            output += `• Available sizes: ${availableSizes.slice(0, 8).join(', ')}\n`;
          }
          
          output += `• Use get-variants ${blueprintId} ${printProviderId} to see all options\n`;
        } else {
          output += `✅ Valid combination found\n\n`;
          
          // Show sample matching variants
          const sampleVariants = matchingVariants.slice(0, 5);
          output += `📋 Sample matching variants:\n`;
          sampleVariants.forEach((variant: any) => {
            const cost = variant.cost ? `$${(variant.cost / 100).toFixed(2)}` : 'N/A';
            output += `  • ID ${variant.id}: ${variant.title} (${cost})\n`;
          });
          
          if (matchingVariants.length > 5) {
            output += `  ... and ${matchingVariants.length - 5} more\n`;
          }
          
          output += `\n💡 Ready for product creation:\n`;
          output += `• These variant IDs can be used in create-product\n`;
          output += `• Use calculate-pricing to determine selling prices\n`;
          output += `• All variants are compatible with this blueprint and provider\n`;
        }
        
        return {
          content: [{
            type: "text",
            text: output
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, `validating variants for blueprint ${blueprintId}, provider ${printProviderId}`);
        
        let validationHelp = `\n🔍 Validation Tips:\n`;
        validationHelp += `• Verify blueprint and provider IDs with validate-blueprint ${blueprintId}\n`;
        validationHelp += `• Check available providers with get-print-providers ${blueprintId}\n`;
        validationHelp += `• Use get-variants ${blueprintId} ${printProviderId} to see all options\n`;
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError + validationHelp
          }]
        };
      }
    }
  );

  // Validate product configuration tool
  server.tool(
    "validate-product-config",
    {
      blueprintId: z.string().describe("Blueprint ID"),
      printProviderId: z.string().describe("Print provider ID"), 
      variantIds: z.array(z.number()).describe("Array of variant IDs to validate"),
      imageId: z.string().optional().describe("Image ID to validate (optional)")
    },
    async ({ blueprintId, printProviderId, variantIds, imageId }) => {
      try {
        let output = `🔍 Product Configuration Validation\n`;
        output += `═══════════════════════════════════\n\n`;
        
        let isValid = true;
        const issues: string[] = [];
        const warnings: string[] = [];
        
        // Validate blueprint and provider
        try {
          await session.printifyClient.getBlueprint(blueprintId);
          output += `✅ Blueprint ${blueprintId}: Valid\n`;
        } catch (error) {
          output += `❌ Blueprint ${blueprintId}: Invalid\n`;
          issues.push(`Blueprint ${blueprintId} not found`);
          isValid = false;
        }
        
        // Validate print provider
        try {
          const providers = await session.printifyClient.getPrintProviders(blueprintId);
          const validProvider = providers.find((p: any) => p.id.toString() === printProviderId);
          if (validProvider) {
            output += `✅ Print Provider ${printProviderId}: Valid\n`;
          } else {
            output += `❌ Print Provider ${printProviderId}: Invalid for this blueprint\n`;
            issues.push(`Print provider ${printProviderId} not available for blueprint ${blueprintId}`);
            isValid = false;
          }
        } catch (error) {
          output += `❌ Print Provider ${printProviderId}: Could not validate\n`;
          issues.push(`Could not validate print provider ${printProviderId}`);
          isValid = false;
        }
        
        // Validate variants
        if (isValid) {
          try {
            const variantsData = await session.printifyClient.getVariants(blueprintId, printProviderId);
            const availableVariants = variantsData.variants || [];
            const availableIds = availableVariants.map((v: any) => v.id);
            
            const invalidVariants = variantIds.filter(id => !availableIds.includes(id));
            const validVariants = variantIds.filter(id => availableIds.includes(id));
            
            output += `✅ Variants: ${validVariants.length}/${variantIds.length} valid\n`;
            
            if (invalidVariants.length > 0) {
              output += `❌ Invalid variant IDs: ${invalidVariants.join(', ')}\n`;
              issues.push(`Invalid variant IDs: ${invalidVariants.join(', ')}`);
              isValid = false;
            }
            
            if (validVariants.length === 0) {
              issues.push('No valid variants specified');
              isValid = false;
            } else if (validVariants.length < 3) {
              warnings.push(`Only ${validVariants.length} variant(s) selected - consider adding more size/color options`);
            }
          } catch (error) {
            output += `❌ Variants: Could not validate\n`;
            issues.push('Could not validate variants');
            isValid = false;
          }
        }
        
        // Validate image if provided
        if (imageId) {
          // For now, we'll assume valid since there's no direct image validation API
          output += `ℹ️ Image ${imageId}: Assumed valid (cannot verify)\n`;
          warnings.push('Image validation not available - ensure image was uploaded successfully');
        }
        
        output += `\n📊 Overall Status: ${isValid ? '✅ VALID' : '❌ INVALID'}\n\n`;
        
        // Show issues
        if (issues.length > 0) {
          output += `🚨 Issues to fix:\n`;
          issues.forEach(issue => output += `  • ${issue}\n`);
          output += `\n`;
        }
        
        // Show warnings
        if (warnings.length > 0) {
          output += `⚠️ Warnings:\n`;
          warnings.forEach(warning => output += `  • ${warning}\n`);
          output += `\n`;
        }
        
        // Provide next steps
        output += `💡 Next Steps:\n`;
        if (isValid) {
          output += `• Configuration is valid - ready for product creation\n`;
          output += `• Use create-product with these exact parameters\n`;
          output += `• Consider testing with create-product-simple first\n`;
        } else {
          output += `• Fix the issues listed above before creating product\n`;
          output += `• Use validate-blueprint ${blueprintId} for blueprint details\n`;
          output += `• Use get-print-providers ${blueprintId} for valid providers\n`;
          output += `• Use get-variants ${blueprintId} {provider_id} for valid variants\n`;
        }
        
        return {
          content: [{
            type: "text",
            text: output
          }]
        };
      } catch (error: any) {
        const formattedError = ResponseFormatter.formatError(error, 'validating product configuration');
        
        return {
          isError: true,
          content: [{
            type: "text",
            text: formattedError
          }]
        };
      }
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
