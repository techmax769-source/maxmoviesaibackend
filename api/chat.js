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

// 🔍 Search MaxMovies API using your actual endpoint
async function searchMaxMovies(query, type = null) {
  try {
    const searchUrl = `${MAXMOVIES_API}/search/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    let items = data?.results?.items || [];
    
    if (items.length === 0) return [];
    
    // Return items exactly as your website expects them
    return items.slice(0, 3).map(item => ({
      subjectId: item.subjectId,
      title: item.title || 'Untitled',
      cover: item.cover?.url || item.thumbnail || null,
      thumbnail: item.thumbnail || item.cover?.url,
      type: item.subjectType === 2 ? 'series' : (item.subjectType === 3 ? 'music' : 'movie'),
      rating: item.imdbRatingValue || (Math.random() * 3 + 7).toFixed(1),
      year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
      subjectType: item.subjectType
    }));
    
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

// 🎬 Get trending content
async function getTrending() {
  try {
    const response = await fetch(`${MAXMOVIES_API}/trending`);
    if (!response.ok) return [];
    const data = await response.json();
    return data?.results?.subjectList || [];
  } catch (err) {
    return [];
  }
}

// 🎬 Get homepage data
async function getHomepage() {
  try {
    const response = await fetch(`${MAXMOVIES_API}/homepage`);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    return null;
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

📋 HOW THUMBNAILS WORK:
When you recommend content, the system will automatically fetch REAL thumbnails from the MaxMovies database. You don't need to provide image URLs or fake IDs.

Just write your recommendations naturally, and the system will attach the thumbnails.

EXAMPLE RESPONSE FORMAT:
Just write your text recommendations like this:
"I recommend these 3 action movies: [explain each one]"

The system will automatically find and attach matching thumbnails from the MaxMovies library.

RULES:
- Always explain WHY you recommend each title
- Consider the user's stated preferences (genre, mood)
- Be spoiler-safe unless asked
- Keep responses helpful and enthusiastic
- You can recommend movies, series, or music
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
    'top rated', 'should i watch', 'looking for', 'any good', 'popular',
    'action', 'comedy', 'drama', 'horror', 'thriller', 'romance', 'sci-fi'
  ];
  return keywords.some(kw => lower.includes(kw));
}

// Extract genre from prompt
function extractGenre(prompt) {
  const lower = prompt.toLowerCase();
  const genres = ['action', 'comedy', 'drama', 'horror', 'thriller', 'romance', 'sci-fi', 'fantasy', 'animation', 'documentary'];
  for (const genre of genres) {
    if (lower.includes(genre)) {
      return genre;
    }
  }
  return null;
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

    // 🔍 Search for real recommendations from your database
    let searchResults = [];
    if (isRecommendationRequest(prompt)) {
      const genre = extractGenre(prompt);
      let searchQuery = genre || 'movie';
      
      // Try searching with genre first
      searchResults = await searchMaxMovies(searchQuery);
      
      // If no results, try 'popular'
      if (searchResults.length === 0) {
        searchResults = await searchMaxMovies('popular');
      }
      
      // If still no results, get trending
      if (searchResults.length === 0) {
        const trending = await getTrending();
        if (trending && trending.length > 0) {
          searchResults = trending.slice(0, 3).map(item => ({
            subjectId: item.subjectId,
            title: item.title,
            cover: item.cover?.url,
            rating: item.imdbRatingValue,
            subjectType: item.subjectType
          }));
        }
      }
    }

    // Build search context for AI
    let searchContext = "";
    if (searchResults.length > 0) {
      searchContext = `\n\nHere are REAL titles from the MaxMovies database that match the user's request. Use these to inform your recommendations:\n${JSON.stringify(searchResults, null, 2)}\n\nWrite natural recommendations about these titles. Do NOT include any JSON or thumbnail markers in your response - just natural text.`;
    }

    const promptText = `
${memory.conversation.slice(-10).map(msg => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`).join("\n")}

User's message: ${prompt}

${searchContext}

Instructions:
- Write helpful, natural recommendations
- Explain WHY each title is worth watching
- Keep it conversational and friendly
- DO NOT include any JSON, code blocks, or special formatting for thumbnails
- Just write normal paragraphs
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
            maxOutputTokens: 800,
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

    const cleanText = fullResponse.replace(/as an ai|language model/gi, "");
    memory.conversation.push({ role: "assistant", content: cleanText });
    
    if (memory.conversation.length > 22) {
      memory.conversation = memory.conversation.slice(-20);
    }
    
    saveMemory(userId, memory);

    // Return thumbnails separately (NOT clickable URLs, just data)
    // The frontend will render them as non-clickable cards
    return res.status(200).json({ 
      reply: cleanText,
      recommendations: searchResults.slice(0, 3).map(item => ({
        subjectId: item.subjectId,
        title: item.title,
        cover: item.cover || item.thumbnail,
        rating: item.rating,
        type: item.subjectType === 2 ? 'series' : (item.subjectType === 3 ? 'music' : 'movie')
      }))
    });
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(503).json({ 
      error: "Service is temporarily unavailable. Please try again in a few minutes." 
    });
  }
}
