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
4. Set environment variables:
   ```
   PORT=3000
   BASE_URL=https://your-app.railway.app
   ```
5. Deploy!

### Local Development

```bash
# Clone the repository
git clone https://github.com/vredrick/printify-mcp-web.git
cd printify-mcp-web

# Install dependencies
npm install

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

## Example Workflow

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

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3000) | No |
| `BASE_URL` | Your deployed server URL | Yes (production) |
| `NODE_ENV` | Environment (development/production) | No |

## Security

- API keys are never exposed to clients
- Each user gets a unique, isolated endpoint
- CORS configured for Claude.com and other MCP clients
- Sessions are maintained server-side

## License

MIT License - see LICENSE file for details

## Support

- [GitHub Issues](https://github.com/vredrick/printify-mcp-web/issues)
- [Printify API Documentation](https://developers.printify.com/)
- [MCP Documentation](https://modelcontextprotocol.io/)
