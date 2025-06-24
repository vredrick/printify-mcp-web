# Printify MCP Web Server

A web-accessible Model Context Protocol (MCP) server for Printify's print-on-demand platform. This server allows AI assistants like Claude to interact with your Printify account through a secure web interface.

## Features

- 🌐 **Web-accessible**: No local installation required for clients
- 🔐 **Secure**: API keys are stored server-side
- 🎨 **AI Image Generation**: Create designs with Replicate's Flux model
- 📦 **Full Printify API**: Manage products, blueprints, and variants
- 🚀 **Easy Deployment**: One-click deploy to Railway or similar platforms

## Quick Start

### Deploy to Railway

1. Fork this repository
2. Sign up at [Railway.app](https://railway.app)
3. Create a new project from your GitHub repo
4. Railway will automatically detect and set the BASE_URL
5. Deploy! (No manual environment variables needed)

### Local Development

```bash
# Clone the repository
git clone https://github.com/vredrick/printify-mcp-web.git
cd printify-mcp-web

# Install dependencies
npm install

# Set environment variables (optional)
export BASE_URL=http://localhost:3000
export PORT=3000

# Run in development mode
npm run dev
```

### Docker Build

```bash
# Build the Docker image
docker build -t printify-mcp-web .

# Run the container
docker run -p 3000:3000 -e PORT=3000 -e BASE_URL=http://localhost:3000 printify-mcp-web
```

**Note**: The Docker build requires at least 2GB of memory. If you encounter build failures, ensure Docker has sufficient memory allocated.

## Usage

1. **Visit your deployed server**: `https://your-app.railway.app`
2. **Enter your API keys**:
   - Printify API Key (required) - Get from [Printify Account Settings](https://printify.com/app/account/api)
   - Replicate API Token (optional) - Get from [Replicate](https://replicate.com/account/api-tokens)
3. **Connect to Claude**:
   - Copy your generated MCP URL
   - In Claude.com, click the paperclip icon
   - Select "Connect to MCP server"
   - Paste your URL

## Available Tools

### Product Management
- `list-products` - List all products in your shop
- `get-product` - Get details of a specific product
- `create-product` - Create a new product
- `update-product` - Update existing product
- `delete-product` - Delete a product
- `publish-product` - Publish product to sales channels

### Shop Management
- `list-shops` - List all available shops
- `switch-shop` - Switch to a different shop

### Design & Images
- `upload-image` - Upload an image from URL or file
- `generate-and-upload-image` - Generate AI image and upload

### Catalog Browsing
- `get-blueprints` - Browse available product types
- `get-blueprint` - Get blueprint details
- `get-print-providers` - Get print providers for a blueprint
- `get-variants` - Get variants (sizes, colors) for a product

## Available Prompts

### 🎨 create-product-wizard
Interactive wizard to guide you through creating a product with best practices
- Parameters: productType, designDescription, targetAudience, priceRange
- Helps with blueprint selection, pricing, and design preparation

### 📦 bulk-product-generator  
Generate multiple product variants from a single design
- Parameters: designId, productTypes, basePrice, namePattern
- Efficiently creates multiple products with consistent settings

### 🖼️ design-upload-assistant
Help prepare and upload designs with optimal settings
- Parameters: designType, intendedProducts, hasTransparency, currentFormat
- Ensures designs meet technical requirements

### ✍️ product-description-writer
Generate SEO-optimized product descriptions
- Parameters: productName, targetKeywords, tone, features, idealCustomer
- Creates compelling titles, descriptions, and tags

## Available Resources

### 📋 design-guidelines
`printify://guidelines/design-requirements`
- Comprehensive design requirements for all products
- DPI, dimensions, safe zones, and file format specifications

### 📏 size-charts
`printify://reference/size-charts`
- Standard size measurements for apparel products
- Includes unisex, women's, and various product types

### 💰 pricing-calculator
`printify://tools/pricing-guide`
- Pricing strategies (keystone, competitive, premium)
- Profit margin calculations and tips

### 📚 blueprint-catalog
`printify://catalog/popular-blueprints`
- Popular products organized by category
- Includes pricing ranges and provider recommendations

### 🚀 api-best-practices
`printify://guides/api-best-practices`
- Rate limits, error handling, and optimization tips
- Image upload best practices and webhook information

## Example Workflows

### Using Prompts
```javascript
// Use the product creation wizard
create-product-wizard({
  productType: "t-shirt",
  designDescription: "minimalist mountain landscape",
  targetAudience: "outdoor enthusiasts",
  priceRange: "mid-range"
})

// Generate SEO-optimized descriptions
product-description-writer({
  productName: "Mountain Adventure Tee",
  targetKeywords: ["mountain", "hiking", "outdoor", "adventure"],
  tone: "casual",
  features: ["soft cotton", "eco-friendly", "unisex fit"],
  idealCustomer: "hikers and nature lovers"
})
```

### Traditional Tool Usage
```javascript
// 1. Get blueprints
get-blueprints()

// 2. Select a t-shirt (blueprint ID 12)
get-print-providers({ blueprintId: "12" })

// 3. Get variants for the selected provider
get-variants({ blueprintId: "12", printProviderId: "29" })

// 4. Generate and upload a design
generate-and-upload-image({
  prompt: "A futuristic cityscape with neon lights",
  fileName: "city-design.png"
})

// 5. Create the product
create-product({
  title: "Neon City T-Shirt",
  description: "A stunning futuristic design",
  blueprintId: 12,
  printProviderId: 29,
  variants: [
    { variantId: 18100, price: 2499 }
  ],
  printAreas: {
    "front": { 
      position: "front", 
      imageId: "generated-image-id" 
    }
  }
})
```

## Environment Variables

| Variable | Description | Required | Default |
|----------|-------------|----------|----------|
| `PORT` | Server port | No | 3000 |
| `BASE_URL` | Your deployed server URL | No | Auto-detected on Railway |
| `NODE_ENV` | Environment (development/production) | No | development |

**Note**: Railway automatically provides `RAILWAY_PUBLIC_DOMAIN` which the server uses to construct the BASE_URL.

## Security

- API keys are never exposed to clients
- Each user gets a unique, isolated endpoint
- CORS configured for Claude.com and other MCP clients
- Sessions are maintained server-side

## Shop Selection

The server automatically selects the first available shop in your Printify account. You can switch shops using the `switch-shop` tool:

```javascript
// List available shops
list-shops()

// Switch to a specific shop
switch-shop({ shopId: "1401238" })
```

## Monitoring & Testing

### Test Connection
Before registering, you can test your API key connection:
- Click "Test Connection Only" button on the registration page
- Shows available shops without creating a session

### Health Check
```bash
curl https://your-app.railway.app/health
```

### Metrics Endpoint
```bash
curl https://your-app.railway.app/metrics
```

Returns detailed server metrics including:
- Active sessions and usage patterns
- Memory usage and uptime
- Deployment configuration

## Troubleshooting

### Common Issues

1. **"Session not found" error**
   - Your session may have expired (1 hour timeout)
   - Re-register to get a new MCP URL

2. **"Shop with ID not found" error**
   - The shop selection may not be persisting correctly
   - Try listing products without switching shops first

3. **Railway deployment not accessible**
   - Check that your Railway app is deployed and running
   - Verify the health endpoint: `https://your-app.railway.app/health`

4. **API key authentication fails**
   - Ensure your Printify API key is valid and active
   - Check that you're using the correct API key format

For more detailed troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

## License

MIT License - see LICENSE file for details

## Support

- [GitHub Issues](https://github.com/vredrick/printify-mcp-web/issues)
- [Printify API Documentation](https://developers.printify.com/)
- [MCP Documentation](https://modelcontextprotocol.io/)
