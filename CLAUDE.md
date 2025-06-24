# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important Patterns

### MCP Server Pattern
The server follows a **stateless pattern** where a new MCP server instance is created for each request:
```typescript
// Create new MCP server instance for this request (following SDK pattern)
const server = createUserMcpServer(session);

// Create transport in stateless mode
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // Stateless mode
});

// Connect and handle request
await server.connect(transport);
await transport.handleRequest(req, res, req.body);
```

### Railway Environment Variables
Railway provides these environment variables automatically:
- `RAILWAY_PUBLIC_DOMAIN` - Used to construct BASE_URL
- `RAILWAY_ENVIRONMENT_NAME` - Environment name (e.g., "production")
- `RAILWAY_SERVICE_NAME` - Service name

### Shop Initialization
The Printify API client automatically selects the first available shop if none is specified:
```typescript
if (!this.shopId && this.shops.length > 0) {
  this.shopId = this.shops[0].id;
}
```

## Development Commands

Build the TypeScript code:
```bash
npm run build
```

Start the server in development mode with hot reload:
```bash
npm run dev
```

Start the production server:
```bash
npm start
```

Build Docker image:
```bash
docker build -t printify-mcp-web .
```

Run Docker container:
```bash
docker run -p 3000:3000 -e PORT=3000 -e BASE_URL=http://localhost:3000 printify-mcp-web
```

## Project Architecture

This is a web-accessible MCP (Model Context Protocol) server that provides Printify API access through a secure web interface. The architecture consists of:

### Core Components

- **server.ts**: Main Express server that hosts the web UI and handles MCP connections
  - Creates unique, isolated endpoints for each user session  
  - Manages API key storage and validation server-side
  - Implements CORS for Claude.com and other MCP clients
  - Provides both POST (MCP requests) and GET (SSE) endpoints

- **printify-api.ts**: Printify API client wrapper
  - Handles authentication and shop management
  - Provides methods for products, blueprints, variants, and print providers
  - Supports image uploads from URLs, base64, and local files
  - Auto-initializes with first available shop if none specified

- **replicate-client.ts**: AI image generation client
  - Uses Replicate's Flux 1.1 Pro model for text-to-image generation
  - Polls for completion with 5-minute timeout
  - Downloads and saves generated images to temp directory
  - Supports custom dimensions, aspect ratios, and generation parameters

### Key Patterns

- **Session Management**: Each user gets a unique endpoint (`/api/mcp/a/{userId}/mcp`) with isolated API keys and state
- **MCP Tool Registration**: Tools are dynamically registered based on available API keys (Printify required, Replicate optional)
- **Error Handling**: API errors are formatted as JSON-RPC responses for MCP compatibility
- **Multi-format Image Support**: Images can be uploaded from URLs, base64 data, or local file paths

### API Integration

The server exposes Printify's full API through MCP tools:
- Shop management (list-shops, switch-shop)
- Product lifecycle (create, read, update, delete, publish)
- Catalog browsing (blueprints, print providers, variants)
- Image operations (upload, generate with AI)

### Deployment

Configured for Railway deployment with:
- Multi-stage Docker build optimizing for production
- Health check endpoint at `/health`
- Environment variables for BASE_URL and PORT
- Automatic shop selection for new users
- `.dockerignore` file to optimize build context
- Memory limits configured to prevent build failures

The registration flow creates unique MCP URLs that can be directly added to Claude.com or other MCP clients without requiring local installation.

## Debugging Tips

### Common Issues and Solutions

1. **Environment Variables Not Loading**
   - Check Railway logs for the environment variable debug output at startup
   - Look for `RAILWAY_PUBLIC_DOMAIN` in the logs
   - Verify BASE_URL is being constructed correctly

2. **Printify API Authentication Failures**
   - Enable verbose logging in `printify-api.ts` by uncommenting console.log statements
   - Check the Authorization header format in logs
   - Verify API key is being passed correctly from registration

3. **Shop Operations Failing**
   - The shop switching feature currently has issues with persisting shop selection
   - Users can work around this by not switching shops and using the default
   - Products can still be accessed without explicit shop switching

4. **MCP Connection Issues**
   - Verify CORS headers are being sent correctly
   - Check that the transport is in stateless mode (sessionIdGenerator: undefined)
   - Ensure server and transport are properly cleaned up on request close

### Debug Commands

```bash
# Check Railway deployment logs
railway logs

# Test health endpoint
curl https://your-app.railway.app/health

# Test MCP endpoint (should return error without proper auth)
curl -X POST https://your-app.railway.app/api/mcp/a/test/mcp

# Check environment variables in Railway
railway variables
```

### Adding Debug Logging

When debugging issues, add logging at these key points:
1. Environment variable loading in server.ts
2. API request/response in printify-api.ts makeRequest()
3. Session creation and retrieval in server.ts
4. MCP server creation and connection

### Docker Build Notes

- The Dockerfile uses a multi-stage build to minimize the final image size
- Build dependencies (python3, make, g++) are included for native Node modules
- The `postinstall` script is skipped in production to avoid TypeScript build errors
- Memory limits are set to prevent out-of-memory errors during npm install

## Debugging Tips

### Common Issues and Solutions

1. **Environment Variables Not Loading**
   - Check Railway logs for the environment variable debug output at startup
   - Look for `RAILWAY_PUBLIC_DOMAIN` in the logs
   - Verify BASE_URL is being constructed correctly

2. **Printify API Authentication Failures**
   - Enable verbose logging in `printify-api.ts` by uncommenting console.log statements
   - Check the Authorization header format in logs
   - Verify API key is being passed correctly from registration

3. **Shop Operations Failing**
   - The shop switching feature currently has issues with persisting shop selection
   - Users can work around this by not switching shops and using the default
   - Products can still be accessed without explicit shop switching

4. **MCP Connection Issues**
   - Verify CORS headers are being sent correctly
   - Check that the transport is in stateless mode (sessionIdGenerator: undefined)
   - Ensure server and transport are properly cleaned up on request close

### Debug Commands

```bash
# Check Railway deployment logs
railway logs

# Test health endpoint
curl https://your-app.railway.app/health

# Test MCP endpoint (should return error without proper auth)
curl -X POST https://your-app.railway.app/api/mcp/a/test/mcp

# Check environment variables in Railway
railway variables
```

### Adding Debug Logging

When debugging issues, add logging at these key points:
1. Environment variable loading in server.ts
2. API request/response in printify-api.ts makeRequest()
3. Session creation and retrieval in server.ts
4. MCP server creation and connection