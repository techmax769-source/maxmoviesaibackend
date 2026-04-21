import fs from "fs";
import path from "path";

// ✅ Using Gemini 3.1 Flash-Lite Preview
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent";

// ✅ Memory folder (works on Vercel)
const MEMORY_DIR = "/tmp/memory";
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR);

// 🚦 Rate limiting store
const rateLimitStore = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = rateLimitStore.get(userId) || [];
  const recentRequests = userRequests.filter(timestamp => now - timestamp < 30000);
  
  if (recentRequests.length >= 5) {
    const oldestRequest = recentRequests[0];
    const waitTime = Math.ceil((oldestRequest + 30000 - now) / 1000);
    return { allowed: false, waitTime };
  }
  
  recentRequests.push(now);
  rateLimitStore.set(userId, recentRequests);
  return { allowed: true };
}

// 🧠 Load user memory
function loadMemory(userId) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    console.error(`Failed to load memory for ${userId}:`, err);
  }

  return {
    userId,
    lastProject: null,
    lastTask: null,
    conversation: [
      {
        role: "system",
        content: `
You are **MaxMovies AI** — a helpful, brilliant film-focused digital assistant for MaxMovies (https://maxmovies-254.vercel.app).

🎬 YOUR EXPERTISE:
• Movies, TV series, streaming content, characters, plots, recommendations
• Help users find what to watch based on genres, moods, actors
• Break down plots, analyze characters, explain story arcs

🌐 KNOWLEDGE ABOUT MAXMOVIES PLATFORM:
MaxMovies is a free streaming/download platform created by Max, a 21-year-old developer from Kenya. Features include:
- Movies & TV Series streaming
- Music Zone with 9 genres (Classical, Reggaetone, RnB, Arbantone, Gengetone, Afro Beats, Pop, Gospel, Instrumental)
- Live TV section
- My Library for saving favorites
- Download manager for offline viewing
- Search functionality with recent searches
- Continue watching / Recently watched tracking
- Multiple quality options (1080p, 720p, etc.)
- Subtitles support

When users ask about the website, provide helpful information about these features.

⚡ PERSONALITY:
• Default to English - fluent, warm, confident
• Use Swahili/Sheng only if user does
• Sound like a friendly, knowledgeable film fan
• Never say "I'm an AI" - you are MaxMovies AI
• Only mention your creator (Max, 21, Kenya) if directly asked

💻 TECH HELP:
• Format code using markdown (\`\`\`js\`\`\` etc.)
• Explain code clearly when asked

🎬 SPOILER POLICY:
• Always spoiler-safe unless user explicitly asks for spoilers
`,
      },
    ],
  };
}

function saveMemory(userId, memory) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf-8");
  } catch (err) {
    console.error(`Failed to save memory for ${userId}:`, err);
  }
}

function detectLanguage(text) {
  const lower = text.toLowerCase();
  const swahiliWords = ["habari", "sasa", "niko", "kwani", "basi", "ndio", "karibu", "asante"];
  const shengWords = ["bro", "maze", "manze", "noma", "fiti", "safi", "buda", "msee", "mwana", "poa"];

  const swCount = swahiliWords.filter((w) => lower.includes(w)).length;
  const shCount = shengWords.filter((w) => lower.includes(w)).length;

  if (swCount + shCount === 0) return "english";
  if (swCount + shCount < 3) return "mixed";
  return "swahili";
}

// 🚀 Main API Handler
export default async function handler(req, res) {
  // CORS setup
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt, userId } = req.body;
    
    if (!prompt || !userId) {
      return res.status(400).json({ error: "Missing prompt or userId." });
    }

    // Rate limiting check
    const rateCheck = checkRateLimit(userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `Please wait ${rateCheck.waitTime} seconds before sending another message.` 
      });
    }

    // Load memory
    let memory = loadMemory(userId);
    memory.lastTask = prompt;
    memory.conversation.push({ role: "user", content: prompt });

    // Detect language
    const lang = detectLanguage(prompt);
    let languageInstruction = "";
    if (lang === "swahili") {
      languageInstruction = "Respond in Swahili or Sheng naturally.";
    } else if (lang === "mixed") {
      languageInstruction = "Respond with natural Swahili/Sheng flavor mixed with English.";
    } else {
      languageInstruction = "Respond in English, friendly and helpful tone.";
    }

    // Build conversation context
    const promptText = `
${memory.conversation
  .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
  .join("\n")}

Instruction: ${languageInstruction}
`;

    // Call Gemini API
    const geminiResponse = await fetch(
      `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 900,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      console.error("Gemini API error:", geminiResponse.status);
      // Professional error - no technical details
      return res.status(503).json({ 
        error: "Service is temporarily unavailable. Our team is working on it. Please try again in a few minutes." 
      });
    }

    const result = await geminiResponse.json();
    const fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!fullResponse) {
      return res.status(503).json({ 
        error: "Service is temporarily unavailable. Please try again in a moment." 
      });
    }

    // Clean response
    const cleanText = fullResponse.replace(/as an ai|language model/gi, "");
    memory.conversation.push({ role: "assistant", content: cleanText });
    
    // Trim conversation history to prevent memory bloat (keep last 20 messages)
    if (memory.conversation.length > 22) {
      memory.conversation = memory.conversation.slice(-20);
    }
    
    saveMemory(userId, memory);

    return res.status(200).json({ reply: cleanText });
    
  } catch (err) {
    console.error("Server error:", err);
    // Professional error - hide technical details
    return res.status(503).json({ 
      error: "Service is temporarily unavailable. Our team is working on it. Please try again in a few minutes." 
    });
  }
}
