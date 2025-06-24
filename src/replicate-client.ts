import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ReplicateClient {
  private apiToken: string;
  private baseUrl = 'https://api.replicate.com/v1';
  private tempDir: string;

  constructor(apiToken: string) {
    this.apiToken = apiToken;
    this.tempDir = path.join(__dirname, '../../temp');
    
    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async generateImage(prompt: string, options: any = {}): Promise<string> {
    try {
      // Prepare the input for Flux 1.1 Pro
      const input: any = {
        prompt: prompt,
        width: options.width || 1024,
        height: options.height || 1024,
        num_inference_steps: options.numInferenceSteps || 25,
        guidance_scale: options.guidanceScale || 7.5,
        negative_prompt: options.negativePrompt || "low quality, bad quality, sketches",
      };

      // Handle aspect ratio if provided
      if (options.aspectRatio) {
        const [widthRatio, heightRatio] = options.aspectRatio.split(':').map(Number);
        const baseSize = 1024;
        
        if (widthRatio > heightRatio) {
          input.width = baseSize;
          input.height = Math.round(baseSize * heightRatio / widthRatio);
        } else {
          input.height = baseSize;
          input.width = Math.round(baseSize * widthRatio / heightRatio);
        }
      }

      // Add seed if provided
      if (options.seed) {
        input.seed = options.seed;
      }

      // Create prediction
      const createResponse = await fetch(`${this.baseUrl}/predictions`, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${this.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          version: "black-forest-labs/flux-1.1-pro",
          input: input
        })
      });

      if (!createResponse.ok) {
        const error = await createResponse.text();
        throw new Error(`Failed to create prediction: ${createResponse.status} - ${error}`);
      }

      const prediction = await createResponse.json() as any;

      // Poll for completion
      let output: string | null = null;
      let attempts = 0;
      const maxAttempts = 60; // 5 minutes timeout (5 seconds * 60)

      while (!output && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        
        const statusResponse = await fetch(`${this.baseUrl}/predictions/${prediction.id}`, {
          headers: {
            'Authorization': `Token ${this.apiToken}`
          }
        });

        if (!statusResponse.ok) {
          throw new Error(`Failed to check prediction status: ${statusResponse.status}`);
        }

        const status = await statusResponse.json() as any;
        
        if (status.status === 'succeeded') {
          output = status.output;
        } else if (status.status === 'failed') {
          throw new Error(`Image generation failed: ${status.error}`);
        }
        
        attempts++;
      }

      if (!output) {
        throw new Error('Image generation timed out');
      }

      // Download the image
      const imageUrl = Array.isArray(output) ? output[0] : output;
      const imageResponse = await fetch(imageUrl);
      
      if (!imageResponse.ok) {
        throw new Error(`Failed to download generated image: ${imageResponse.status}`);
      }

      // Save to temp file
      const fileName = `generated_${Date.now()}.png`;
      const filePath = path.join(this.tempDir, fileName);
      
      const buffer = Buffer.from(await imageResponse.arrayBuffer());
      await fs.promises.writeFile(filePath, buffer);

      return filePath;
    } catch (error: any) {
      // Provide detailed error information
      const errorDetails = {
        message: error.message,
        prompt: prompt,
        options: JSON.stringify(options)
      };

      throw new Error(`Replicate API error: ${error.message}\nDetails: ${JSON.stringify(errorDetails, null, 2)}`);
    }
  }

  // For direct use with ImgBB when needed
  async generateImageBase64(prompt: string, options: any = {}): Promise<string> {
    const imagePath = await this.generateImage(prompt, options);
    const imageBuffer = await fs.promises.readFile(imagePath);
    const base64 = imageBuffer.toString('base64');
    
    // Clean up temp file
    await fs.promises.unlink(imagePath);
    
    return base64;
  }
}
