// Simple script to test OpenAI API with o3 models
const OpenAI = require('openai');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_API_MODEL || 'o3-mini';

if (!API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is not set');
  process.exit(1);
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: API_KEY,
});

async function testOpenAI() {
  console.log(`Testing OpenAI API with model: ${MODEL}`);
  
  // Determine if using o3 model
  const isOModel = MODEL.startsWith('o');
  
  // Create config based on model type
  const config = {
    model: MODEL,
    messages: [
      {
        role: "system",
        content: "You are a code review assistant. Focus ONLY on substantive issues like bugs, security vulnerabilities, and performance problems. DO NOT make generic observations about hardcoded values or suggest 'verifying' configuration values without specific technical reasons. Format your response as a JSON object with a 'reviews' array.",
      },
      {
        role: "user",
        content: `Review this TypeScript code:
        
function calculateTotal(items: any[]): number {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].price;
  }
  return total;
}

Analyze for SUBSTANTIVE issues related to:
1. Code quality and best practices 
2. Potential bugs or logical errors
3. Security vulnerabilities
4. Performance optimizations
5. Maintainability and readability

Provide ONLY specific, actionable feedback in JSON format.`,
      }
    ],
  };
  
  // Add the appropriate tokens parameter
  if (isOModel) {
    config.max_completion_tokens = 2000;
    config.response_format = { type: "json_object" }; // Ensure JSON format response
  } else {
    config.max_tokens = 2000;
    config.temperature = 0.2;
  }
  
  console.log('Using configuration:', JSON.stringify(config, null, 2));
  
  try {
    console.log('Sending request to OpenAI...');
    const response = await openai.chat.completions.create(config);
    
    console.log('Response received:');
    console.log(JSON.stringify(response, null, 2));
    
    console.log('\nContent:');
    console.log(response.choices[0]?.message?.content);
  } catch (error) {
    console.error('Error calling OpenAI API:');
    console.error(error.message);
    
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testOpenAI();