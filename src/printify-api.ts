import fetch from 'node-fetch';
import { promises as fs } from 'fs';

// Error codes for better error handling
export enum PrintifyErrorCode {
  AUTH_FAILED = 'AUTH_FAILED',
  RATE_LIMIT = 'RATE_LIMIT',
  NOT_FOUND = 'NOT_FOUND',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT = 'TIMEOUT',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

export class PrintifyError extends Error {
  code: PrintifyErrorCode;
  statusCode?: number;
  context?: any;

  constructor(message: string, code: PrintifyErrorCode, statusCode?: number, context?: any) {
    super(message);
    this.name = 'PrintifyError';
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
  }
}

export interface PrintifyShop {
  id: string;
  title: string;
  sales_channel: string;
}

// Blueprint categories for searching
export const BLUEPRINT_CATEGORIES = {
  apparel: {
    tshirt: [5, 6, 12, 384, 921], // Various t-shirt blueprints (6 is Gildan 64000 T-Shirt)
    hoodie: [77, 380], // 77 is Gildan 18500 Hoodie
    tanktop: [17, 387],
    longsleeve: [245, 378]
  },
  accessories: {
    mug: [265, 635, 1041],
    totebag: [634, 821],
    phonecase: [269, 555],
    sticker: [1037, 1201]
  },
  home: {
    poster: [520, 521],
    canvas: [446, 1158],
    blanket: [647, 961],
    pillow: [560, 1052]
  }
} as const;

export interface PrintifyProduct {
  id: string;
  title: string;
  description: string;
  tags: string[];
  options: any[];
  variants: any[];
  images: any[];
  created_at: string;
  updated_at: string;
  visible: boolean;
  blueprint_id: number;
  print_provider_id: number;
  user_id: number;
  shop_id: number;
  sales_channel_properties: any;
}

export interface PrintifyImage {
  id: string;
  file_name: string;
  height: number;
  width: number;
  size: number;
  mime_type: string;
  preview_url: string;
  upload_time: string;
}

// Simple cache for blueprint data
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Response formatting utilities
export class ResponseFormatter {
  // Format blueprints list as a compact table
  static formatBlueprintsList(blueprints: any[], options: { includeDescription?: boolean; maxItems?: number } = {}): string {
    const { includeDescription = true, maxItems = 20 } = options;
    const items = blueprints.slice(0, maxItems);
    
    if (items.length === 0) {
      return "No blueprints found.";
    }

    let output = `Found ${blueprints.length} blueprints${maxItems < blueprints.length ? ` (showing first ${maxItems})` : ''}:\n\n`;
    
    // Create table header
    output += includeDescription 
      ? "┌─────────┬──────────────────────────────────┬─────────────────────────────────┐\n"
      + "│   ID    │             Name                 │          Description            │\n"
      + "├─────────┼──────────────────────────────────┼─────────────────────────────────┤\n"
      : "┌─────────┬──────────────────────────────────────────────────────────────────┐\n"
      + "│   ID    │                           Name                                   │\n"
      + "├─────────┼──────────────────────────────────────────────────────────────────┤\n";

    // Add blueprint rows
    items.forEach(bp => {
      const id = String(bp.id).padEnd(7);
      const name = (bp.title || 'Unnamed').substring(0, 30).padEnd(30);
      
      if (includeDescription) {
        const desc = (bp.description || bp.brand || '').substring(0, 29).padEnd(29);
        output += `│ ${id} │ ${name} │ ${desc} │\n`;
      } else {
        const longName = (bp.title || 'Unnamed').substring(0, 62).padEnd(62);
        output += `│ ${id} │ ${longName} │\n`;
      }
    });
    
    // Close table
    output += includeDescription 
      ? "└─────────┴──────────────────────────────────┴─────────────────────────────────┘\n"
      : "└─────────┴──────────────────────────────────────────────────────────────────┘\n";

    // Add usage guidance
    output += "\n💡 Next Steps:\n";
    output += "• Use get-blueprint {id} for detailed information about a specific blueprint\n";
    output += "• Use get-popular-blueprints for commonly used products\n";
    output += "• Use search-blueprints to filter by category (apparel/accessories/home)\n";
    
    if (maxItems < blueprints.length) {
      output += `• Use pagination: get-blueprints page=2 to see more results\n`;
    }

    return output;
  }

  // Format blueprint details for single blueprint
  static formatBlueprintDetails(blueprint: any): string {
    const title = blueprint.title || 'Unnamed Blueprint';
    const id = blueprint.id || 'Unknown';
    const brand = blueprint.brand || 'Unknown';
    const model = blueprint.model || 'N/A';
    const description = blueprint.description || 'No description available';

    let output = `📋 Blueprint Details\n`;
    output += `═══════════════════\n\n`;
    output += `🆔 ID: ${id}\n`;
    output += `📝 Name: ${title}\n`;
    output += `🏢 Brand: ${brand}\n`;
    output += `🔧 Model: ${model}\n`;
    output += `📄 Description: ${description}\n\n`;

    output += `💡 Next Steps:\n`;
    output += `• Use get-print-providers ${id} to see available print providers\n`;
    output += `• Use validate-blueprint ${id} to check compatibility\n`;
    output += `• Use this ID in create-product or create-product-simple\n`;

    return output;
  }

  // Format print providers list
  static formatPrintProviders(providers: any[], blueprintId: string): string {
    if (!providers || providers.length === 0) {
      return `❌ No print providers available for blueprint ${blueprintId}`;
    }

    let output = `🖨️ Print Providers for Blueprint ${blueprintId}\n`;
    output += `══════════════════════════════════════════\n\n`;

    providers.forEach((provider, index) => {
      const isRecommended = index === 0; // First provider is usually recommended
      output += `${isRecommended ? '⭐ ' : '• '}Provider ${provider.id}: ${provider.title || 'Unnamed'}\n`;
      if (provider.location) output += `  📍 Location: ${provider.location}\n`;
      output += `\n`;
    });

    output += `💡 Next Steps:\n`;
    output += `• Use get-variants ${blueprintId} {provider_id} to see available variants\n`;
    output += `• Provider ${providers[0]?.id} is typically recommended (shown with ⭐)\n`;

    return output;
  }

  // Format variants in a compact way
  static formatVariants(variants: any[], blueprintId: string, printProviderId: string): string {
    if (!variants || variants.length === 0) {
      return `❌ No variants available for blueprint ${blueprintId} with provider ${printProviderId}`;
    }

    let output = `👕 Available Variants\n`;
    output += `Blueprint ${blueprintId} → Provider ${printProviderId}\n`;
    output += `═══════════════════════════════════════\n\n`;

    // Group variants by color for better readability
    const variantsByColor = new Map<string, any[]>();
    
    variants.forEach(variant => {
      const title = variant.title || 'Unknown';
      // Extract color (everything before the first '/')
      const colorMatch = title.match(/^([^\/]+)/);
      const color = colorMatch ? colorMatch[1].trim() : 'Unknown Color';
      
      if (!variantsByColor.has(color)) {
        variantsByColor.set(color, []);
      }
      variantsByColor.get(color)!.push(variant);
    });

    // Display grouped variants
    for (const [color, colorVariants] of variantsByColor) {
      output += `🎨 ${color}:\n`;
      colorVariants.forEach(variant => {
        const sizeMatch = variant.title.match(/\/\s*(.+)$/);
        const size = sizeMatch ? sizeMatch[1].trim() : 'One Size';
        const cost = variant.cost ? `$${(variant.cost / 100).toFixed(2)}` : 'N/A';
        output += `  • ID ${variant.id}: ${size} (Base cost: ${cost})\n`;
      });
      output += `\n`;
    }

    output += `💡 Next Steps:\n`;
    output += `• Use these variant IDs in create-product variants array\n`;
    output += `• Use calculate-pricing to determine selling prices\n`;
    output += `• Use validate-variants to check compatibility before creating product\n`;

    return output;
  }

  // Format product creation success
  static formatProductCreated(product: any, blueprint?: any): string {
    let output = `✅ Product Created Successfully!\n`;
    output += `═══════════════════════════════\n\n`;
    output += `🆔 Product ID: ${product.id}\n`;
    output += `📝 Title: ${product.title}\n`;
    output += `📋 Blueprint: ${blueprint?.title || `ID ${product.blueprint_id}`}\n`;
    output += `🏪 Shop: ${product.shop_id}\n`;
    output += `👕 Variants: ${product.variants?.length || 0} enabled\n`;
    output += `🖼️ Print Areas: ${product.print_areas?.length || 0} configured\n`;
    output += `👁️ Visible: ${product.visible ? 'Yes' : 'No'}\n\n`;

    output += `💡 Next Steps:\n`;
    output += `• Use publish-product ${product.id} to make it available in your store\n`;
    output += `• Use get-product ${product.id} to view current status\n`;
    output += `• Use update-product ${product.id} to modify details if needed\n`;

    return output;
  }

  // Format error messages with helpful context
  static formatError(error: any, context?: string): string {
    let output = `❌ Error${context ? ` ${context}` : ''}\n`;
    output += `═══════════════════════\n\n`;
    output += `🚨 ${error.message || 'An unknown error occurred'}\n\n`;

    // Add specific troubleshooting based on error type
    if (error.code === 'AUTH_FAILED') {
      output += `🔧 Troubleshooting:\n`;
      output += `• Check your Printify API key is valid\n`;
      output += `• Ensure the key is active in your account\n`;
      output += `• Try generating a new API key at printify.com\n`;
    } else if (error.code === 'RATE_LIMIT') {
      output += `🔧 Troubleshooting:\n`;
      output += `• Wait 60 seconds before retrying\n`;
      output += `• Reduce the number of requests\n`;
      output += `• Use smaller page limits for list operations\n`;
    } else if (error.code === 'NOT_FOUND') {
      output += `🔧 Troubleshooting:\n`;
      output += `• Verify the ID exists (use list operations to check)\n`;
      output += `• Check you're using the correct shop\n`;
      output += `• Ensure the resource wasn't deleted\n`;
    } else if (error.code === 'VALIDATION_ERROR') {
      output += `🔧 Troubleshooting:\n`;
      output += `• Check all required fields are provided\n`;
      output += `• Verify data types (numbers vs strings)\n`;
      output += `• Use validation tools before creating products\n`;
    }

    return output;
  }

  // Response size management utilities
  static checkResponseSize(data: any): { size: number; warning?: string; action?: string } {
    const jsonString = JSON.stringify(data);
    const sizeInBytes = Buffer.byteLength(jsonString, 'utf8');
    const sizeInKB = Math.round(sizeInBytes / 1024);
    
    if (sizeInKB > 100) {
      return {
        size: sizeInKB,
        warning: `⚠️ Large response detected (${sizeInKB}KB)`,
        action: sizeInKB > 500 ? 'Use pagination or filtering to reduce response size' : 'Consider using pagination flags for better performance'
      };
    }
    
    return { size: sizeInKB };
  }

  static addResponseSizeWarning(response: string, data?: any): string {
    if (data) {
      const sizeCheck = this.checkResponseSize(data);
      if (sizeCheck.warning) {
        const warning = `\n${sizeCheck.warning}\n`;
        const action = sizeCheck.action ? `💡 ${sizeCheck.action}\n` : '';
        return response + warning + action;
      }
    }
    return response;
  }

  static formatWithPagination<T>(
    items: T[], 
    currentPage: number = 1, 
    pageSize: number = 20,
    formatFunction: (items: T[]) => string,
    totalItems?: number
  ): string {
    const total = totalItems || items.length;
    const totalPages = Math.ceil(total / pageSize);
    const startIndex = (currentPage - 1) * pageSize;
    const endIndex = Math.min(startIndex + pageSize, items.length);
    const pageItems = items.slice(startIndex, endIndex);
    
    let output = formatFunction(pageItems);
    
    if (totalPages > 1) {
      output += `\n📄 Pagination Info:\n`;
      output += `• Page ${currentPage} of ${totalPages}\n`;
      output += `• Showing items ${startIndex + 1}-${Math.min(endIndex, total)} of ${total}\n`;
      
      if (currentPage < totalPages) {
        output += `• Use page=${currentPage + 1} for next page\n`;
      }
      if (currentPage > 1) {
        output += `• Use page=${currentPage - 1} for previous page\n`;
      }
      
      // Add quick navigation for large result sets
      if (totalPages > 5) {
        const suggestions = [];
        if (currentPage !== 1) suggestions.push('page=1 (first)');
        if (totalPages > 10 && currentPage < totalPages - 5) suggestions.push(`page=${Math.ceil(totalPages / 2)} (middle)`);
        if (currentPage !== totalPages) suggestions.push(`page=${totalPages} (last)`);
        
        if (suggestions.length > 0) {
          output += `• Quick navigation: ${suggestions.join(', ')}\n`;
        }
      }
    }
    
    return output;
  }

  static truncateForPreview(text: string, maxLength: number = 1000): string {
    if (text.length <= maxLength) {
      return text;
    }
    
    const truncated = text.slice(0, maxLength);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > maxLength * 0.8 ? lastNewline : maxLength;
    
    return text.slice(0, cutPoint) + `\n\n... (truncated, ${text.length - cutPoint} more characters)\n💡 Use specific tools or pagination to get complete data`;
  }

  static getResponseSizeGuidance(): string {
    return `\n📊 Response Size Management:\n` +
      `• Large responses (>100KB) will show size warnings\n` +
      `• Use page parameter for pagination: get-blueprints page=2\n` +
      `• Use maxItems parameter to limit results: get-blueprints maxItems=10\n` +
      `• Use specific filters to reduce data: search-blueprints category=apparel\n` +
      `• Prefer targeted tools over broad listing operations\n`;
  }
}

export class PrintifyAPI {
  private apiToken: string;
  public shopId: string | undefined;
  private baseUrl = 'https://api.printify.com/v1';
  public shops: PrintifyShop[] = [];
  private blueprintCache = new Map<string, CacheEntry<any>>();
  private cacheTimeout = 3600000; // 1 hour cache

  constructor(apiToken: string, shopId?: string) {
    this.apiToken = apiToken;
    this.shopId = shopId;
  }

  private async makeCatalogRequest(endpoint: string, options: any = {}, retries: number = 3): Promise<any> {
    // Special handling for catalog endpoints with longer timeout
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiToken}`,
      'User-Agent': 'printify-mcp-web/1.0.0',
      'Content-Type': 'application/json;charset=utf-8',
      'Connection': 'keep-alive',
      'Keep-Alive': 'timeout=60',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      ...options.headers
    };

    const debugMode = process.env.PRINTIFY_DEBUG === 'true';
    if (debugMode) {
      console.log(`[DEBUG] Making catalog request to: ${url}`);
      console.log('[DEBUG] Method:', options.method || 'GET');
      console.log('[DEBUG] Headers:', { ...headers, Authorization: 'Bearer ***' });
      if (options.body) {
        try {
          const bodyData = JSON.parse(options.body);
          console.log('[DEBUG] Request body:', JSON.stringify(bodyData, null, 2));
        } catch {
          console.log('[DEBUG] Request body (raw):', options.body);
        }
      }
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60 second timeout for catalog
        const startTime = Date.now();
        
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal,
          compress: true // Enable compression
        });
        
        clearTimeout(timeout);
        const responseTime = Date.now() - startTime;

        if (debugMode) {
          console.log(`[DEBUG] Catalog response received in ${responseTime}ms`);
          console.log(`[DEBUG] Response status: ${response.status}`);
          const contentLength = response.headers.get('content-length');
          if (contentLength) {
            console.log(`[DEBUG] Response size: ${contentLength} bytes`);
          }
        }

        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = `Printify API error: ${response.status}`;
          
          // Parse error details if possible
          let errorDetails = null;
          try {
            const errorJson = JSON.parse(errorText);
            
            // Handle various error response formats
            if (errorJson.error) {
              errorMessage = errorJson.error;
              errorDetails = errorJson;
            } else if (errorJson.message) {
              errorMessage = errorJson.message;
              errorDetails = errorJson;
            } else if (errorJson.errors) {
              // Handle validation errors with field-specific details
              errorMessage = 'Validation failed';
              const fieldErrors = Object.entries(errorJson.errors)
                .map(([field, errors]: [string, any]) => {
                  const errorList = Array.isArray(errors) ? errors : [errors];
                  return `  ${field}: ${errorList.join(', ')}`;
                })
                .join('\n');
              errorMessage += '\n\nField errors:\n' + fieldErrors;
              errorDetails = errorJson;
            } else {
              // If we have any other structure, include it
              errorMessage += '\n\nDetails: ' + JSON.stringify(errorJson, null, 2);
              errorDetails = errorJson;
            }
          } catch {
            errorMessage += ` - ${errorText}`;
          }

          // Map status codes to error codes with helpful recovery messages
          let errorCode = PrintifyErrorCode.UNKNOWN_ERROR;
          if (response.status === 401) {
            errorCode = PrintifyErrorCode.AUTH_FAILED;
            errorMessage += '\n\nTo fix:\n1. Check your Printify API key is valid\n2. Ensure the key is active in your account\n3. Try generating a new API key at printify.com';
          } else if (response.status === 429) {
            errorCode = PrintifyErrorCode.RATE_LIMIT;
            errorMessage += '\n\nTo fix:\n1. Wait 60 seconds before retrying\n2. Reduce the number of requests\n3. Use smaller page limits for list operations';
          } else if (response.status === 404) {
            errorCode = PrintifyErrorCode.NOT_FOUND;
            errorMessage += '\n\nTo fix:\n1. Verify the ID exists (use list operations)\n2. Check you\'re using the correct shop\n3. Ensure the resource wasn\'t deleted';
          } else if (response.status === 400 || response.status === 422) {
            errorCode = PrintifyErrorCode.VALIDATION_ERROR;
            errorMessage += '\n\nTo fix:\n1. Check all required fields are provided\n2. Verify data types (numbers vs strings)\n3. Use example values from tool descriptions';
          } else if (response.status >= 500) {
            errorCode = PrintifyErrorCode.SERVER_ERROR;
            errorMessage += '\n\nTo fix:\n1. Wait a few minutes and retry\n2. Check Printify status page\n3. Try a simpler request to test connectivity';
          }

          if (debugMode) {
            console.error(`[DEBUG] Catalog API error response:`, errorText);
          }
          
          // Retry on rate limit or server errors
          if ((response.status === 429 || response.status >= 500) && attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
            console.log(`Retrying catalog request after ${delay}ms (attempt ${attempt + 1}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
          throw new PrintifyError(errorMessage, errorCode, response.status, { endpoint, errorText, errorDetails });
        }

        const result = await response.json() as any;
        if (debugMode) {
          console.log('[DEBUG] Catalog response received successfully');
          if (result.data && Array.isArray(result.data)) {
            console.log(`[DEBUG] Catalog response contains ${result.data.length} items`);
          }
        }
        return result;
      } catch (error: any) {
        // Handle timeout/abort errors
        if (error.name === 'AbortError') {
          console.error(`Catalog request timeout after 60s: ${url}`);
          if (attempt < retries) {
            const delay = Math.min(2000 * Math.pow(2, attempt), 10000);
            console.log(`Retrying catalog request after timeout (attempt ${attempt + 1}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw new PrintifyError(
            `Catalog request timeout after 60 seconds: ${endpoint}. Try using a smaller limit parameter.`,
            PrintifyErrorCode.TIMEOUT,
            undefined,
            { endpoint, url }
          );
        }
        
        // Retry on network errors
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'EPIPE') {
          if (attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            console.log(`Network error (${error.code}), retrying catalog request after ${delay}ms (attempt ${attempt + 1}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw new PrintifyError(
            `Network error during catalog request: ${error.code || error.message}`,
            PrintifyErrorCode.NETWORK_ERROR,
            undefined,
            { endpoint, errorCode: error.code }
          );
        }
        
        if (debugMode) {
          console.error('[DEBUG] Catalog request failed:', error);
        }
        throw error;
      }
    }
  }

  private async makeRequest(endpoint: string, options: any = {}, retries: number = 3): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiToken}`,
      'User-Agent': 'printify-mcp-web/1.0.0',
      'Content-Type': 'application/json;charset=utf-8',
      'Connection': 'keep-alive',
      'Keep-Alive': 'timeout=30',
      ...options.headers
    };

    const debugMode = process.env.PRINTIFY_DEBUG === 'true';
    if (debugMode) {
      console.log(`[DEBUG] Making request to: ${url}`);
      console.log('[DEBUG] Method:', options.method || 'GET');
      console.log('[DEBUG] Headers:', { ...headers, Authorization: 'Bearer ***' });
      if (options.body) {
        try {
          const bodyData = JSON.parse(options.body);
          console.log('[DEBUG] Request body:', JSON.stringify(bodyData, null, 2));
        } catch {
          console.log('[DEBUG] Request body (raw):', options.body);
        }
      }
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout
        
        const response = await fetch(url, {
          ...options,
          headers,
          signal: controller.signal
        });
        
        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = `Printify API error: ${response.status}`;
          
          // Parse error details if possible
          let errorDetails = null;
          try {
            const errorJson = JSON.parse(errorText);
            
            // Handle various error response formats
            if (errorJson.error) {
              errorMessage = errorJson.error;
              errorDetails = errorJson;
            } else if (errorJson.message) {
              errorMessage = errorJson.message;
              errorDetails = errorJson;
            } else if (errorJson.errors) {
              // Handle validation errors with field-specific details
              errorMessage = 'Validation failed';
              const fieldErrors = Object.entries(errorJson.errors)
                .map(([field, errors]: [string, any]) => {
                  const errorList = Array.isArray(errors) ? errors : [errors];
                  return `  ${field}: ${errorList.join(', ')}`;
                })
                .join('\n');
              errorMessage += '\n\nField errors:\n' + fieldErrors;
              errorDetails = errorJson;
            } else {
              // If we have any other structure, include it
              errorMessage += '\n\nDetails: ' + JSON.stringify(errorJson, null, 2);
              errorDetails = errorJson;
            }
          } catch {
            errorMessage += ` - ${errorText}`;
          }

          // Map status codes to error codes with helpful recovery messages
          let errorCode = PrintifyErrorCode.UNKNOWN_ERROR;
          if (response.status === 401) {
            errorCode = PrintifyErrorCode.AUTH_FAILED;
            errorMessage += '\n\nTo fix:\n1. Check your Printify API key is valid\n2. Ensure the key is active in your account\n3. Try generating a new API key at printify.com';
          } else if (response.status === 429) {
            errorCode = PrintifyErrorCode.RATE_LIMIT;
            errorMessage += '\n\nTo fix:\n1. Wait 60 seconds before retrying\n2. Reduce the number of requests\n3. Use smaller page limits for list operations';
          } else if (response.status === 404) {
            errorCode = PrintifyErrorCode.NOT_FOUND;
            errorMessage += '\n\nTo fix:\n1. Verify the ID exists (use list operations)\n2. Check you\'re using the correct shop\n3. Ensure the resource wasn\'t deleted';
          } else if (response.status === 400 || response.status === 422) {
            errorCode = PrintifyErrorCode.VALIDATION_ERROR;
            errorMessage += '\n\nTo fix:\n1. Check all required fields are provided\n2. Verify data types (numbers vs strings)\n3. Use example values from tool descriptions';
          } else if (response.status >= 500) {
            errorCode = PrintifyErrorCode.SERVER_ERROR;
            errorMessage += '\n\nTo fix:\n1. Wait a few minutes and retry\n2. Check Printify status page\n3. Try a simpler request to test connectivity';
          }

          if (debugMode) {
            console.error(`[DEBUG] API error response:`, errorText);
          }
          
          // Retry on rate limit or server errors
          if ((response.status === 429 || response.status >= 500) && attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
            console.log(`Retrying after ${delay}ms (attempt ${attempt + 1}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          
          throw new PrintifyError(errorMessage, errorCode, response.status, { endpoint, errorText, errorDetails });
        }

        const result = await response.json();
        if (debugMode) {
          console.log('[DEBUG] Response received successfully');
        }
        return result;
      } catch (error: any) {
        // Handle timeout/abort errors
        if (error.name === 'AbortError') {
          console.error(`Request timeout after 30s: ${url}`);
          if (attempt < retries) {
            const delay = Math.min(2000 * Math.pow(2, attempt), 10000);
            console.log(`Retrying after timeout (attempt ${attempt + 1}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw new PrintifyError(
            `Request timeout after 30 seconds: ${endpoint}`,
            PrintifyErrorCode.TIMEOUT,
            undefined,
            { endpoint, url }
          );
        }
        
        // Retry on network errors
        if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'EPIPE') {
          if (attempt < retries) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            console.log(`Network error (${error.code}), retrying after ${delay}ms (attempt ${attempt + 1}/${retries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw new PrintifyError(
            `Network error: ${error.code || error.message}`,
            PrintifyErrorCode.NETWORK_ERROR,
            undefined,
            { endpoint, errorCode: error.code }
          );
        }
        
        if (debugMode) {
          console.error('[DEBUG] Request failed:', error);
        }
        throw error;
      }
    }
  }

  async initialize(): Promise<PrintifyShop[]> {
    console.log('Printify API initialize called');
    console.log('API Token:', this.apiToken ? this.apiToken.substring(0, 10) + '...' : 'None');
    console.log('Making request to /shops.json');
    
    // Fetch available shops
    this.shops = await this.makeRequest('/shops.json');
    
    console.log(`Found ${this.shops.length} shops`);
    
    // If no shop ID is provided, use the first shop
    if (!this.shopId && this.shops.length > 0) {
      this.shopId = String(this.shops[0].id);
      console.log(`Using default shop: ${this.shops[0].title} (${this.shopId})`);
    }
    
    return this.shops;
  }

  async getShops(): Promise<PrintifyShop[]> {
    return this.shops;
  }

  async setShop(shopId: string) {
    // Convert both IDs to strings for comparison since API returns numbers
    const shop = this.shops.find(s => String(s.id) === String(shopId));
    if (!shop) {
      const availableShops = this.shops.map(s => `${s.title} (ID: ${s.id})`).join(', ');
      throw new Error(
        `Shop with ID "${shopId}" not found. Available shops: ${availableShops || 'none'}. ` +
        `Note: Shop switching has known issues. Try using the default shop without switching.`
      );
    }
    this.shopId = String(shop.id);
    console.log(`Switched to shop: ${shop.title} (${shop.id})`);
  }

  async getProducts(page: number = 1, limit: number = 10): Promise<any> {
    if (!this.shopId) {
      throw new Error(
        'No shop selected. The shop should be automatically selected on initialization. ' +
        'Try re-registering if this error persists.'
      );
    }
    
    return this.makeRequest(`/shops/${this.shopId}/products.json?page=${page}&limit=${limit}`);
  }

  async getProduct(productId: string): Promise<PrintifyProduct> {
    if (!this.shopId) {
      throw new Error(
        'No shop selected. The shop should be automatically selected on initialization. ' +
        'Try re-registering if this error persists.'
      );
    }
    
    return this.makeRequest(`/shops/${this.shopId}/products/${productId}.json`);
  }

  async createProduct(productData: any): Promise<PrintifyProduct> {
    if (!this.shopId) {
      throw new Error(
        'No shop selected. The shop should be automatically selected on initialization. ' +
        'Try re-registering if this error persists.'
      );
    }
    
    const formattedData = {
      title: productData.title,
      description: productData.description,
      blueprint_id: productData.blueprintId,
      print_provider_id: productData.printProviderId,
      variants: productData.variants.map((v: any) => ({
        id: v.variantId,
        price: v.price,
        is_enabled: v.isEnabled !== false
      })),
      print_areas: productData.printAreas ? 
        Object.entries(productData.printAreas).map(([, area]: [string, any]) => ({
          variant_ids: productData.variants.map((v: any) => v.variantId),
          placeholders: [{
            position: area.position,
            images: [{
              id: area.imageId,
              x: area.x !== undefined ? area.x : 0.5,
              y: area.y !== undefined ? area.y : 0.5,
              scale: area.scale !== undefined ? area.scale : 1.0,
              angle: area.angle !== undefined ? area.angle : 0
            }]
          }]
        })) : []
    };

    return this.makeRequest(`/shops/${this.shopId}/products.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(formattedData)
    });
  }

  async updateProduct(productId: string, productData: any): Promise<PrintifyProduct> {
    if (!this.shopId) throw new Error('No shop selected');
    
    const formattedData: any = {};
    
    if (productData.title) formattedData.title = productData.title;
    if (productData.description) formattedData.description = productData.description;
    
    if (productData.variants) {
      formattedData.variants = productData.variants.map((v: any) => ({
        id: v.variantId,
        price: v.price,
        is_enabled: v.isEnabled !== false
      }));
    }

    return this.makeRequest(`/shops/${this.shopId}/products/${productId}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(formattedData)
    });
  }

  async deleteProduct(productId: string): Promise<void> {
    if (!this.shopId) throw new Error('No shop selected');
    
    await this.makeRequest(`/shops/${this.shopId}/products/${productId}.json`, {
      method: 'DELETE'
    });
  }

  async publishProduct(productId: string, publishDetails?: any): Promise<any> {
    if (!this.shopId) throw new Error('No shop selected');
    
    const data = {
      title: publishDetails?.title !== false,
      description: publishDetails?.description !== false,
      images: publishDetails?.images !== false,
      variants: publishDetails?.variants !== false,
      tags: publishDetails?.tags !== false
    };

    return this.makeRequest(`/shops/${this.shopId}/products/${productId}/publish.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });
  }

  private convertGoogleDriveUrl(url: string): string {
    // Convert Google Drive sharing URLs to direct download URLs
    const patterns = [
      // https://drive.google.com/file/d/{id}/view
      /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/view/,
      // https://drive.google.com/open?id={id}
      /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
      // https://drive.google.com/uc?id={id}&export=download (already direct)
      /drive\.google\.com\/uc\?.*id=([a-zA-Z0-9_-]+)/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        const fileId = match[1];
        // Return direct download URL
        return `https://drive.google.com/uc?export=download&id=${fileId}`;
      }
    }
    
    // Return original URL if not a Google Drive URL
    return url;
  }

  async uploadImage(fileName: string, source: string): Promise<PrintifyImage> {
    let requestBody: any = {
      file_name: fileName
    };

    // Determine source type and prepare request body
    if (source.startsWith('http://') || source.startsWith('https://')) {
      // Convert Google Drive URLs automatically
      const convertedUrl = this.convertGoogleDriveUrl(source);
      if (convertedUrl !== source && process.env.PRINTIFY_DEBUG === 'true') {
        console.log(`[DEBUG] Converted Google Drive URL: ${source} -> ${convertedUrl}`);
      }
      requestBody.url = convertedUrl;
    } else {
      // For local files or base64, we need to convert to base64
      let imageData: Buffer;
      
      if (source.startsWith('data:')) {
        // Already base64 data
        const matches = source.match(/^data:(.+);base64,(.+)$/);
        if (!matches) throw new Error('Invalid base64 data');
        requestBody.contents = matches[2];
      } else {
        // Local file path - read and convert to base64
        imageData = await fs.readFile(source);
        requestBody.contents = imageData.toString('base64');
      }
    }

    console.log(`Uploading image: ${fileName} (${requestBody.url ? 'from URL' : 'from base64 data'})`);

    // Upload to Printify using JSON format
    const response = await fetch(`${this.baseUrl}/uploads/images.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'User-Agent': 'printify-mcp-web/1.0.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Upload failed with status ${response.status}:`, error);
      throw new Error(`Failed to upload image: ${response.status} - ${error}`);
    }

    const result = await response.json();
    console.log('Image uploaded successfully:', result);
    return result as PrintifyImage;
  }

  private getCacheKey(endpoint: string): string {
    return `cache:${endpoint}`;
  }

  private getFromCache<T>(key: string): T | null {
    const cached = this.blueprintCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      if (process.env.PRINTIFY_DEBUG === 'true') {
        console.log(`[DEBUG] Cache hit for: ${key}`);
      }
      return cached.data;
    }
    return null;
  }

  private setCache<T>(key: string, data: T): void {
    this.blueprintCache.set(key, { data, timestamp: Date.now() });
  }

  async getBlueprints(page: number = 1, limit: number = 10): Promise<any> {
    const cacheKey = this.getCacheKey(`blueprints:${page}:${limit}`);
    
    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    // Use progressively smaller limits if failures occur
    const limitsToTry = [Math.min(limit, 5), 3, 1];
    let lastError: any;

    for (const currentLimit of limitsToTry) {
      try {
        console.log(`Attempting to fetch blueprints with limit=${currentLimit}...`);
        const result = await this.makeCatalogRequest(`/catalog/blueprints.json?page=${page}&limit=${currentLimit}`);
        
        // If we had to use a smaller limit, adjust the response
        if (currentLimit < limit && result.data) {
          console.log(`Successfully fetched blueprints with reduced limit (${currentLimit} instead of ${limit})`);
        }
        
        this.setCache(cacheKey, result);
        return result;
      } catch (error: any) {
        lastError = error;
        console.error(`Failed to fetch blueprints with limit=${currentLimit}:`, error.message);
        
        // Don't retry if it's an auth error
        if (error.code === PrintifyErrorCode.AUTH_FAILED) {
          throw error;
        }
        
        // Continue to next attempt with smaller limit
        if (currentLimit > 1) {
          console.log('Retrying with smaller limit...');
          await new Promise(resolve => setTimeout(resolve, 1000)); // Brief delay between attempts
        }
      }
    }

    // If all attempts fail, provide enhanced fallback data
    console.error('All attempts to fetch blueprints failed:', lastError?.message);
    
    // Return enhanced fallback blueprint data
    const fallbackBlueprints = {
      data: [
        { 
          id: 5, 
          title: 'Bella + Canvas 3001 Unisex T-Shirt', 
          description: 'Premium unisex t-shirt, soft and comfortable',
          brand: 'Bella + Canvas',
          model: '3001'
        },
        { 
          id: 77, 
          title: 'Gildan 18500 Unisex Hoodie', 
          description: 'Classic pullover hoodie',
          brand: 'Gildan',
          model: '18500'
        },
        { 
          id: 6, 
          title: 'Gildan 64000 Unisex T-Shirt',
          description: 'Affordable basic t-shirt',
          brand: 'Gildan',
          model: '64000'
        },
        { 
          id: 384, 
          title: 'Bella + Canvas 3413 Unisex Triblend T-shirt',
          description: 'Tri-blend fabric for ultimate softness',
          brand: 'Bella + Canvas',
          model: '3413'
        },
        { 
          id: 265, 
          title: 'Ceramic Mug 11oz', 
          description: 'Standard coffee mug, dishwasher safe',
          brand: 'Generic',
          model: '11oz'
        },
        { 
          id: 520, 
          title: 'Poster', 
          description: 'Wall poster in various sizes',
          brand: 'Generic',
          model: 'Poster'
        },
        { 
          id: 634, 
          title: 'Tote Bag',
          description: 'Canvas tote bag for everyday use',
          brand: 'Generic',
          model: 'Tote'
        },
        { 
          id: 1037, 
          title: 'Sticker',
          description: 'Die-cut vinyl stickers',
          brand: 'Generic',
          model: 'Sticker'
        }
      ],
      current_page: page,
      last_page: 1,
      total: 8,
      per_page: limit,
      _fallback: true,
      _message: 'Using cached blueprint data. For live catalog, try using get-blueprints with limit=3 or check your connection.'
    };
    
    console.log('Using enhanced fallback blueprint data. For full catalog access:');
    console.log('1. Try calling get-blueprints with limit=3');
    console.log('2. Check your internet connection');
    console.log('3. Enable debug mode with PRINTIFY_DEBUG=true for more details');
    
    return fallbackBlueprints;
  }

  async getBlueprint(blueprintId: string): Promise<any> {
    const cacheKey = this.getCacheKey(`blueprint:${blueprintId}`);
    
    // Check cache first
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.makeRequest(`/catalog/blueprints/${blueprintId}.json`);
    this.setCache(cacheKey, result);
    return result;
  }

  async getPrintProviders(blueprintId: string): Promise<any> {
    return this.makeRequest(`/catalog/blueprints/${blueprintId}/print_providers.json`);
  }

  async getVariants(blueprintId: string, printProviderId: string): Promise<any> {
    return this.makeRequest(`/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`);
  }

  // Search blueprints by category and type
  async searchBlueprints(category?: string, type?: string): Promise<any> {
    let allBlueprints;
    
    try {
      allBlueprints = await this.getBlueprints(1, 50);
    } catch (error: any) {
      // If API fails, use fallback data for searching
      console.log('Failed to fetch blueprints, using fallback data for search:', error.message);
      allBlueprints = null;
    }
    
    // Ensure we always have valid blueprint data
    if (!allBlueprints || !allBlueprints.data || !Array.isArray(allBlueprints.data)) {
      // Create fallback response with searchable data
      allBlueprints = {
        data: [
          { id: 5, title: 'Bella + Canvas 3001 Unisex T-Shirt', description: 'Premium unisex t-shirt' },
          { id: 77, title: 'Gildan 18500 Unisex Hoodie', description: 'Classic pullover hoodie' },
          { id: 6, title: 'Gildan 64000 Unisex T-Shirt', description: 'Basic t-shirt' },
          { id: 380, title: 'Independent Trading Co. Hoodie', description: 'Heavy blend hoodie' },
          { id: 265, title: 'Ceramic Mug 11oz', description: 'Standard coffee mug' },
          { id: 634, title: 'Tote Bag', description: 'Canvas tote bag' },
          { id: 520, title: 'Poster', description: 'Wall poster' },
          { id: 1037, title: 'Sticker', description: 'Die-cut vinyl stickers' },
          { id: 12, title: 'Next Level 3600 T-Shirt', description: 'Premium fitted t-shirt' },
          { id: 384, title: 'Bella + Canvas 3413 Triblend T-shirt', description: 'Tri-blend t-shirt' }
        ],
        _fallback: true,
        _message: 'Using cached blueprint data'
      };
    }
    
    // Return all blueprints if no search criteria
    if (!category && !type) {
      return allBlueprints;
    }

    // If using fallback data, filter by known categories
    if (allBlueprints._fallback) {
      const categoryData = category ? (BLUEPRINT_CATEGORIES as any)[category] : null;
      let filteredData = allBlueprints.data;
      
      // Filter by category and type using known IDs
      if (category && type && categoryData?.[type]) {
        const blueprintIds = categoryData[type];
        filteredData = allBlueprints.data.filter((bp: any) => blueprintIds.includes(bp.id));
      } else {
        // Filter by text search on title/description
        const searchTerms: string[] = [];
        if (type) searchTerms.push(type.toLowerCase());
        if (category) searchTerms.push(category.toLowerCase());
        
        if (searchTerms.length > 0) {
          filteredData = allBlueprints.data.filter((bp: any) => {
            const searchText = `${bp.title} ${bp.description || ''}`.toLowerCase();
            return searchTerms.some(term => searchText.includes(term));
          });
        }
      }
      
      return {
        ...allBlueprints,
        data: filteredData,
        total: filteredData.length,
        _filtered: true
      };
    }

    // For real API data, filter by title/description
    const searchTerms: string[] = [];
    if (type) searchTerms.push(type.toLowerCase());
    if (category) searchTerms.push(category.toLowerCase());
    
    // Ensure data exists before filtering
    const dataToFilter = allBlueprints.data || [];
    const filteredData = searchTerms.length > 0 
      ? dataToFilter.filter((bp: any) => {
          const searchText = `${bp.title || ''} ${bp.description || ''}`.toLowerCase();
          return searchTerms.some(term => searchText.includes(term));
        })
      : dataToFilter;
    
    return {
      ...allBlueprints,
      data: filteredData,
      total: filteredData.length,
      _filtered: searchTerms.length > 0
    };
  }

  // Get popular blueprints for quick access
  async getPopularBlueprints(): Promise<any> {
    const popularIds = [
      5,   // Bella + Canvas 3001 T-Shirt
      77,  // Gildan 18500 Hoodie (corrected from ID 6)
      265, // Ceramic Mug 11oz
      634, // Tote Bag
      520, // Poster
      1037 // Sticker
    ];

    try {
      const allBlueprints = await this.getBlueprints(1, 20);
      
      if (allBlueprints._fallback) {
        // Filter fallback data to just popular items
        const popularData = allBlueprints.data.filter((bp: any) => popularIds.includes(bp.id));
        return {
          ...allBlueprints,
          data: popularData,
          total: popularData.length,
          _popular: true
        };
      }

      // Filter to popular items
      const filtered = {
        ...allBlueprints,
        data: allBlueprints.data.filter((bp: any) => popularIds.includes(bp.id)),
        total: allBlueprints.data.filter((bp: any) => popularIds.includes(bp.id)).length,
        _popular: true
      };

      return filtered;
    } catch (error) {
      // Return curated popular list with correct data
      return {
        data: [
          { id: 5, title: 'Bella + Canvas 3001 T-Shirt', brand: 'Bella + Canvas', description: 'Premium unisex t-shirt', _popular: true },
          { id: 77, title: 'Gildan 18500 Hoodie', brand: 'Gildan', description: 'Classic pullover hoodie', _popular: true },
          { id: 265, title: 'Ceramic Mug 11oz', brand: 'Generic', description: 'Standard coffee mug', _popular: true },
          { id: 634, title: 'Tote Bag', brand: 'Generic', description: 'Canvas tote bag', _popular: true },
          { id: 520, title: 'Poster', brand: 'Generic', description: 'Wall poster', _popular: true },
          { id: 1037, title: 'Sticker', brand: 'Generic', description: 'Die-cut vinyl stickers', _popular: true }
        ],
        total: 6,
        _fallback: true,
        _popular: true
      };
    }
  }

  // Calculate pricing based on base cost and desired profit margin
  calculatePricing(baseCost: number, profitMargin: number | string): { price: number; profit: number } {
    // Convert profit margin to number if it's a percentage string
    let margin = typeof profitMargin === 'string' 
      ? parseFloat(profitMargin.replace('%', '')) / 100
      : profitMargin;

    // If margin is greater than 1, assume it's a percentage (e.g., 50 instead of 0.5)
    if (margin > 1) {
      margin = margin / 100;
    }

    // Calculate price based on margin
    const price = Math.round(baseCost / (1 - margin));
    const profit = price - baseCost;

    return {
      price, // Price in cents
      profit // Profit in cents
    };
  }
}
