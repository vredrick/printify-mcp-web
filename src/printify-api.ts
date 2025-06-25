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
          try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.error) {
              errorMessage = errorJson.error;
            } else if (errorJson.message) {
              errorMessage = errorJson.message;
            }
          } catch {
            errorMessage += ` - ${errorText}`;
          }

          // Map status codes to error codes
          let errorCode = PrintifyErrorCode.UNKNOWN_ERROR;
          if (response.status === 401) {
            errorCode = PrintifyErrorCode.AUTH_FAILED;
            errorMessage += '. Please check that your API key is valid and active in your Printify account settings.';
          } else if (response.status === 429) {
            errorCode = PrintifyErrorCode.RATE_LIMIT;
            errorMessage += '. Rate limit exceeded. Please wait a moment and try again.';
          } else if (response.status === 404) {
            errorCode = PrintifyErrorCode.NOT_FOUND;
            errorMessage += '. The requested resource was not found. It may have been deleted or the ID is incorrect.';
          } else if (response.status === 400 || response.status === 422) {
            errorCode = PrintifyErrorCode.VALIDATION_ERROR;
            errorMessage += '. Request validation failed. Check your input parameters.';
          } else if (response.status >= 500) {
            errorCode = PrintifyErrorCode.SERVER_ERROR;
            errorMessage += '. Printify server error. Please try again later.';
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
          
          throw new PrintifyError(errorMessage, errorCode, response.status, { endpoint, errorText });
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
          try {
            const errorJson = JSON.parse(errorText);
            if (errorJson.error) {
              errorMessage = errorJson.error;
            } else if (errorJson.message) {
              errorMessage = errorJson.message;
            }
          } catch {
            errorMessage += ` - ${errorText}`;
          }

          // Map status codes to error codes
          let errorCode = PrintifyErrorCode.UNKNOWN_ERROR;
          if (response.status === 401) {
            errorCode = PrintifyErrorCode.AUTH_FAILED;
            errorMessage += '. Please check that your API key is valid and active in your Printify account settings.';
          } else if (response.status === 429) {
            errorCode = PrintifyErrorCode.RATE_LIMIT;
            errorMessage += '. Rate limit exceeded. Please wait a moment and try again.';
          } else if (response.status === 404) {
            errorCode = PrintifyErrorCode.NOT_FOUND;
            errorMessage += '. The requested resource was not found. It may have been deleted or the ID is incorrect.';
          } else if (response.status === 400 || response.status === 422) {
            errorCode = PrintifyErrorCode.VALIDATION_ERROR;
            errorMessage += '. Request validation failed. Check your input parameters.';
          } else if (response.status >= 500) {
            errorCode = PrintifyErrorCode.SERVER_ERROR;
            errorMessage += '. Printify server error. Please try again later.';
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
          
          throw new PrintifyError(errorMessage, errorCode, response.status, { endpoint, errorText });
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
              x: 0,
              y: 0,
              scale: 1,
              angle: 0
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
          id: 6, 
          title: 'Gildan 18500 Unisex Hoodie', 
          description: 'Classic pullover hoodie',
          brand: 'Gildan',
          model: '18500'
        },
        { 
          id: 384, 
          title: 'Bella + Canvas 3413 Unisex Triblend T-shirt',
          description: 'Tri-blend fabric for ultimate softness',
          brand: 'Bella + Canvas',
          model: '3413'
        },
        { 
          id: 12, 
          title: 'Gildan 64000 Unisex T-Shirt',
          description: 'Affordable basic t-shirt',
          brand: 'Gildan',
          model: '64000'
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
}
