import fetch from 'node-fetch';
import FormData from 'form-data';
import { promises as fs } from 'fs';
import path from 'path';

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

export class PrintifyAPI {
  private apiToken: string;
  private shopId: string | undefined;
  private baseUrl = 'https://api.printify.com/v1';
  private shops: PrintifyShop[] = [];

  constructor(apiToken: string, shopId?: string) {
    this.apiToken = apiToken;
    this.shopId = shopId;
  }

  private async makeRequest(endpoint: string, options: any = {}): Promise<any> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiToken}`,
      ...options.headers
    };

    console.log(`Making request to: ${url}`);
    console.log('Authorization header:', headers.Authorization ? 'Bearer ' + headers.Authorization.substring(7, 17) + '...' : 'None');

    const response = await fetch(url, {
      ...options,
      headers
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`Printify API error response:`, error);
      throw new Error(`Printify API error: ${response.status} - ${error}`);
    }

    return response.json();
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
      this.shopId = this.shops[0].id;
      console.log(`Using default shop: ${this.shops[0].title} (${this.shopId})`);
    }
    
    return this.shops;
  }

  async getShops(): Promise<PrintifyShop[]> {
    return this.shops;
  }

  async setShop(shopId: string) {
    const shop = this.shops.find(s => s.id === shopId);
    if (!shop) {
      throw new Error(`Shop with ID ${shopId} not found`);
    }
    this.shopId = shopId;
  }

  async getProducts(page: number = 1, limit: number = 10): Promise<any> {
    if (!this.shopId) throw new Error('No shop selected');
    
    return this.makeRequest(`/shops/${this.shopId}/products.json?page=${page}&limit=${limit}`);
  }

  async getProduct(productId: string): Promise<PrintifyProduct> {
    if (!this.shopId) throw new Error('No shop selected');
    
    return this.makeRequest(`/shops/${this.shopId}/products/${productId}.json`);
  }

  async createProduct(productData: any): Promise<PrintifyProduct> {
    if (!this.shopId) throw new Error('No shop selected');
    
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
        Object.entries(productData.printAreas).map(([key, area]: [string, any]) => ({
          variant_ids: productData.variants.map((v: any) => v.variantId),
          placeholders: [{
            position: area.position,
            images: [{
              id: area.imageId,
              x: 0.5,
              y: 0.5,
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

  async uploadImage(fileName: string, source: string): Promise<PrintifyImage> {
    let imageData: Buffer;
    let contentType = 'image/png';

    // Determine source type and load image data
    if (source.startsWith('http://') || source.startsWith('https://')) {
      // Download from URL
      const response = await fetch(source);
      imageData = Buffer.from(await response.arrayBuffer());
      contentType = response.headers.get('content-type') || 'image/png';
    } else if (source.startsWith('data:')) {
      // Base64 data
      const matches = source.match(/^data:(.+);base64,(.+)$/);
      if (!matches) throw new Error('Invalid base64 data');
      
      contentType = matches[1];
      imageData = Buffer.from(matches[2], 'base64');
    } else {
      // Local file path
      imageData = await fs.readFile(source);
      const ext = path.extname(source).toLowerCase();
      contentType = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp'
      }[ext] || 'image/png';
    }

    // Create form data
    const form = new FormData();
    form.append('file', imageData, {
      filename: fileName,
      contentType: contentType
    });

    // Upload to Printify
    const response = await fetch(`${this.baseUrl}/uploads/images.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        ...form.getHeaders()
      },
      body: form as any
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to upload image: ${response.status} - ${error}`);
    }

    return response.json() as Promise<PrintifyImage>;
  }

  async getBlueprints(page: number = 1, limit: number = 10): Promise<any> {
    return this.makeRequest(`/catalog/blueprints.json?page=${page}&limit=${limit}`);
  }

  async getBlueprint(blueprintId: string): Promise<any> {
    return this.makeRequest(`/catalog/blueprints/${blueprintId}.json`);
  }

  async getPrintProviders(blueprintId: string): Promise<any> {
    return this.makeRequest(`/catalog/blueprints/${blueprintId}/print_providers.json`);
  }

  async getVariants(blueprintId: string, printProviderId: string): Promise<any> {
    return this.makeRequest(`/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`);
  }
}
