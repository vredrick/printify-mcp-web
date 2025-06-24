# Troubleshooting Guide

This guide covers common issues and solutions for the Printify MCP Web Server.

## Common Issues

### 1. Connection Errors

#### "There was an error connecting to printify server" in Claude.ai

**Symptoms:**
- Claude.ai shows connection error
- Registration succeeds but MCP connection fails

**Solutions:**
1. Verify your Railway deployment is running:
   ```bash
   curl https://your-app.railway.app/health
   ```

2. Check that the registration returned a valid URL:
   - Should be `https://your-app.railway.app/api/mcp/a/{userId}/mcp`
   - Not `http://localhost:3000/...`

3. Ensure CORS is properly configured (should be automatic)

#### "Session not found" error

**Symptoms:**
- MCP tools return session not found error
- Connection was working but stopped

**Cause:** Sessions expire after 1 hour of inactivity

**Solution:** Re-register to get a new MCP URL

### 2. Shop Management Issues

#### "Shop with ID not found" error

**Symptoms:**
- `switch-shop` command fails
- Shop ID appears valid from `list-shops`

**Current Status:** Known issue with shop persistence

**Workaround:**
- Use the default shop (automatically selected)
- Access products without switching shops:
  ```javascript
  list-products({ limit: 10 })
  ```

### 3. Railway Deployment Issues

#### Health check failures

**Symptoms:**
- Railway shows deployment as unhealthy
- Site is not accessible

**Solutions:**
1. Check deployment logs in Railway dashboard
2. Verify server is binding to `0.0.0.0:${PORT}`
3. Ensure PORT environment variable is set (Railway provides this)

#### Environment variables not loading

**Symptoms:**
- BASE_URL shows as undefined in logs
- Registration returns localhost URLs

**Solutions:**
1. Railway automatically provides `RAILWAY_PUBLIC_DOMAIN`
2. No manual BASE_URL configuration needed
3. Check logs for environment variable debug output

### 4. Printify API Issues

#### 401 Authentication Error

**Symptoms:**
- "Printify API error: 401" in logs
- Valid API key but authentication fails

**Solutions:**
1. Verify API key is active in Printify dashboard
2. Check API key format (should start with "eyJ...")
3. Ensure no extra spaces or characters in API key

#### Rate Limiting

**Symptoms:**
- Intermittent 429 errors
- Requests suddenly start failing

**Solution:** Printify has rate limits. Wait a few minutes and retry.

### 5. Docker Build Issues

#### Exit code 137 (Out of Memory)

**Symptoms:**
- Docker build fails during npm install
- Exit code 137

**Solution:** Increase Docker memory allocation (minimum 2GB recommended)

#### TypeScript compilation errors

**Symptoms:**
- Build fails with TypeScript errors
- import.meta errors

**Solution:** The production build skips TypeScript compilation. This is normal.

## Debug Mode

To enable verbose logging:

1. **Server-side logging:**
   - Logs are automatically enabled for environment variables
   - API requests show sanitized auth headers
   - Check Railway logs for details

2. **Client-side debugging:**
   - Open browser console when registering
   - Check network tab for API responses

## Getting Help

1. **Check logs first:**
   ```bash
   railway logs --tail 100
   ```

2. **Verify deployment:**
   ```bash
   curl https://your-app.railway.app/health
   ```

3. **Test registration:**
   - Visit `https://your-app.railway.app`
   - Try registering with your API key
   - Check browser console for errors

4. **Report issues:**
   - [GitHub Issues](https://github.com/vredrick/printify-mcp-web/issues)
   - Include error messages and logs
   - Mention your deployment platform (Railway, etc.)

## Quick Fixes

### Reset Everything
1. Delete your Railway deployment
2. Create a new deployment from GitHub
3. Re-register with your API keys

### Test Locally First
```bash
npm run dev
# Visit http://localhost:3000
# Test with your API keys locally
```

### Verify API Keys
```bash
# Test Printify API directly
curl -H "Authorization: Bearer YOUR_API_KEY" \
  https://api.printify.com/v1/shops.json
```

## Known Limitations

1. **Shop switching** - Currently has persistence issues
2. **Session timeout** - 1 hour of inactivity
3. **Concurrent requests** - Each request creates a new MCP server instance
4. **File uploads** - Only URL and base64 uploads supported (no direct file uploads)