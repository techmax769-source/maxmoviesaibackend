import fs from "fs";
import path from "path";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent";
const MAXMOVIES_API = "https://maxmoviesbackend.vercel.app/api/v2";

const MEMORY_DIR = "/tmp/memory";
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR);

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

// 🔍 Search MaxMovies API
async function searchMaxMovies(query, type = null) {
  try {
    const searchUrl = `${MAXMOVIES_API}/search/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    let items = data?.results?.items || [];
    
    if (items.length === 0) return [];
    
    return items.slice(0, 3).map(item => ({
      id: item.subjectId,
      title: item.title || 'Untitled',
      thumbnail: item.cover?.url || item.thumbnail || null,
      type: item.subjectType === 2 ? 'series' : (item.subjectType === 3 ? 'music' : 'movie'),
      rating: item.imdbRatingValue || (Math.random() * 3 + 7).toFixed(1),
      year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null
    }));
    
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

function loadMemory(userId) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    console.error(`Failed to load memory:`, err);
  }

  return {
    userId,
    conversation: [
      {
        role: "system",
        content: `
You are **MaxMovies AI** for MaxMovies (https://maxmovies-254.vercel.app).

🎬 YOUR ROLE:
- Help users find movies, series, and music on MaxMovies
- Provide detailed recommendations with analysis
- Show up to 3 small thumbnails when recommending content
- Answer questions about the platform's features

📋 WHEN TO SHOW THUMBNAILS (max 3):
- "recommend me something"
- "best movies/series/music"
- "what should I watch"
- "suggest something good"
- Any recommendation request

THUMBNAIL FORMAT (include at end of your response):
---THUMBNAILS---
[{"id":"123","title":"Movie Name","thumbnail":"url","type":"movie","rating":"8.5","year":2024}]
---END---

Always provide thoughtful analysis explaining WHY you recommend each title.
Be spoiler-safe unless asked.
Keep responses helpful and enthusiastic about movies/series/music.
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
    console.error(`Failed to save memory:`, err);
  }
}

function isRecommendationRequest(prompt) {
  const lower = prompt.toLowerCase();
  const keywords = [
    'recommend', 'suggest', 'what to watch', 'best movie', 'good series',
    'top rated', 'should i watch', 'looking for', 'any good', 'popular'
  ];
  return keywords.some(kw => lower.includes(kw));
}

export default async function handler(req, res) {
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

    const rateCheck = checkRateLimit(userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `Please wait ${rateCheck.waitTime} seconds before sending another message.` 
      });
    }

    let memory = loadMemory(userId);
    memory.conversation.push({ role: "user", content: prompt });

    // 🔍 Search for recommendations if user asks
    let searchResults = [];
    if (isRecommendationRequest(prompt)) {
      let searchQuery = 'popular';
      const genres = ['action', 'comedy', 'drama', 'horror', 'romance', 'sci-fi', 'thriller', 'music'];
      for (const genre of genres) {
        if (prompt.toLowerCase().includes(genre)) {
          searchQuery = genre;
          break;
        }
      }
      searchResults = await searchMaxMovies(searchQuery);
    }

    let searchContext = "";
    if (searchResults.length > 0) {
      searchContext = `\n\nI found these titles from MaxMovies that match the user's request:\n${JSON.stringify(searchResults, null, 2)}\n\nProvide a helpful recommendation for each (2-3 sentences per title). Then include the thumbnail data using the format: ---THUMBNAILS---[json]---END---`;
    }

    const promptText = `
${memory.conversation.slice(-10).map(msg => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`).join("\n")}

User's message: ${prompt}

${searchContext}

Respond in a friendly, helpful tone about movies, series, and music.
`;

    const geminiResponse = await fetch(
      `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 1000,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      console.error("Gemini API error:", geminiResponse.status);
      return res.status(503).json({ 
        error: "Service is temporarily unavailable. Please try again in a few minutes." 
      });
    }

    const result = await geminiResponse.json();
    let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!fullResponse) {
      return res.status(503).json({ 
        error: "Service is temporarily unavailable. Please try again in a moment." 
      });
    }

    // Extract thumbnails from response
    let thumbnails = [];
    const thumbnailMatch = fullResponse.match(/---THUMBNAILS---\n?([\s\S]*?)\n?---END---/);
    if (thumbnailMatch && thumbnailMatch[1]) {
      try {
        thumbnails = JSON.parse(thumbnailMatch[1]);
        fullResponse = fullResponse.replace(/---THUMBNAILS---[\s\S]*?---END---/, '').trim();
      } catch (e) {
        console.error("Failed to parse thumbnails:", e);
      }
    }

    // If AI didn't generate thumbnails but we have search results, use them
    if (thumbnails.length === 0 && searchResults.length > 0) {
      thumbnails = searchResults.slice(0, 3);
    }

    const cleanText = fullResponse.replace(/as an ai|language model/gi, "");
    memory.conversation.push({ role: "assistant", content: cleanText });
    
    if (memory.conversation.length > 22) {
      memory.conversation = memory.conversation.slice(-20);
    }
    
    saveMemory(userId, memory);

    return res.status(200).json({ 
      reply: cleanText,
      thumbnails: thumbnails.slice(0, 3)
    });
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(503).json({ 
      error: "Service is temporarily unavailable. Please try again in a few minutes." 
    });
  }
}
