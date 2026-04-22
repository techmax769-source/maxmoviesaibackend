import fs from "fs";
import path from "path";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent";
const MAXMOVIES_API = "https://maxmoviesbackend.vercel.app/api/v2";
const SITE_URL = "https://maxmovies-254.vercel.app";

const MEMORY_DIR = "/tmp/memory";
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR);

const rateLimitStore = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = rateLimitStore.get(userId) || [];
  const recentRequests = userRequests.filter(timestamp => now - timestamp < 30000);
  
  if (recentRequests.length >= 8) {
    const oldestRequest = recentRequests[0];
    const waitTime = Math.ceil((oldestRequest + 30000 - now) / 1000);
    return { allowed: false, waitTime };
  }
  
  recentRequests.push(now);
  rateLimitStore.set(userId, recentRequests);
  return { allowed: true };
}

// 🔍 Search MaxMovies API - returns up to 6 results
async function searchMaxMovies(query, limit = 6) {
  try {
    const searchUrl = `${MAXMOVIES_API}/search/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    let items = data?.results?.items || [];
    
    if (items.length === 0) return [];
    
    // Return up to 6 items
    return items.slice(0, limit).map(item => ({
      subjectId: item.subjectId,
      title: item.title || 'Untitled',
      cover: item.cover?.url || item.thumbnail || null,
      type: item.subjectType === 2 ? 'series' : (item.subjectType === 3 ? 'music' : 'movie'),
      rating: item.imdbRatingValue || null,
      year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
      description: item.description?.substring(0, 120) || ''
    }));
    
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

// 🎬 Get trending content as fallback (max 6)
async function getTrending(limit = 6) {
  try {
    const response = await fetch(`${MAXMOVIES_API}/trending`);
    if (!response.ok) return [];
    const data = await response.json();
    const items = data?.results?.subjectList || [];
    return items.slice(0, limit).map(item => ({
      subjectId: item.subjectId,
      title: item.title,
      cover: item.cover?.url || item.thumbnail,
      rating: item.imdbRatingValue,
      type: item.subjectType === 2 ? 'series' : 'movie'
    }));
  } catch (err) {
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
        content: `You are MaxMovies AI - a FUN, ENERGETIC movie expert! 

🎬 YOUR PERSONALITY:
- Be short, punchy, and exciting!
- Use emojis 🎬 🍿 🔥 ✨ 😎 🎭 🎨
- **Bold movie/series titles** using **Title**
- Keep recommendations under 3 sentences per title
- Sound like a chill movie buddy

RULES:
- NEVER over-explain
- Bold ALL movie/series names using **Title**
- Be spoiler-safe`,
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

// Extract the main topic/subject from user's query
function extractSearchTopic(prompt) {
  const lower = prompt.toLowerCase();
  
  // Remove common question words
  let topic = prompt.replace(/what is|tell me about|info on|details about|search for|find|look up|show me|recommend|suggest|best|good|top/gi, '');
  
  // Remove extra words
  topic = topic.replace(/movie|series|film|show|anime|cartoon|documentary|about|for/gi, '');
  
  // Clean up
  topic = topic.trim();
  
  if (topic.length < 2) return null;
  return topic;
}

function isSearchQuery(prompt) {
  const lower = prompt.toLowerCase();
  const searchWords = ['what is', 'tell me about', 'info on', 'details about', 'search for', 'find', 'look up'];
  return searchWords.some(word => lower.includes(word)) || (lower.length > 3 && !lower.includes('recommend'));
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        error: `⏰ Chill for ${rateCheck.waitTime} seconds, bro!` 
      });
    }

    let memory = loadMemory(userId);
    memory.conversation.push({ role: "user", content: prompt });

    // 🔍 ALWAYS search for content - any query that mentions a movie/series
    let searchResults = [];
    const searchTopic = extractSearchTopic(prompt);
    
    if (searchTopic && searchTopic.length > 2) {
      // Search for the specific topic (max 6)
      searchResults = await searchMaxMovies(searchTopic, 6);
    }
    
    // If no results, try trending (max 6)
    if (searchResults.length === 0) {
      searchResults = await getTrending(6);
    }
    
    // If still no results, try a general search (max 6)
    if (searchResults.length === 0) {
      searchResults = await searchMaxMovies('movie', 6);
    }

    // Build search context for AI
    let searchContext = "";
    if (searchResults.length > 0) {
      searchContext = `\n\n🎬 REAL content from MaxMovies database matching "${prompt}":\n${JSON.stringify(searchResults, null, 2)}\n\nRespond with SHORT, EXCITING info about these. **Bold each title**. Use emojis!`;
    } else {
      searchContext = `\n\nNo exact matches found. Give helpful movie/series advice in a fun, short way.`;
    }

    const promptText = `
User asked: "${prompt}"

${searchContext}

Instructions:
1. Be EXCITING and use EMOJIS 🎬 🍿 🔥
2. **Bold every movie/series name** using **Title**
3. Keep it SHORT - max 3 sentences per title
4. Sound like a cool movie buddy
5. Start with a fun reaction

Example: "🎬 **John Wick 4** - Pure adrenaline 🔥 The action is insane!"

Go!
`;

    const geminiResponse = await fetch(
      `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 600,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      console.error("Gemini API error:", geminiResponse.status);
      return res.status(503).json({ 
        error: "🎬 Service is busy. Try again in a sec, bro!" 
      });
    }

    const result = await geminiResponse.json();
    let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!fullResponse) {
      return res.status(503).json({ 
        error: "🎬 No response. Try again!" 
      });
    }

    // Clean up
    let cleanText = fullResponse.replace(/as an ai|language model/gi, "");
    
    // Add clickable links with correct hash routing for each mentioned title
    if (searchResults.length > 0) {
      searchResults.forEach(movie => {
        if (movie.title && movie.title.length > 2) {
          const titlePattern = new RegExp(`\\*\\*${escapeRegex(movie.title)}\\*\\*`, 'gi');
          const link = `<a href="${SITE_URL}/#detail/${movie.subjectId}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${movie.title}</a>`;
          cleanText = cleanText.replace(titlePattern, link);
        }
      });
    }
    
    memory.conversation.push({ role: "assistant", content: cleanText });
    
    if (memory.conversation.length > 20) {
      memory.conversation = memory.conversation.slice(-18);
    }
    
    saveMemory(userId, memory);

    // Return up to 6 search results
    return res.status(200).json({ 
      reply: cleanText,
      recommendations: searchResults.slice(0, 6).map(item => ({
        subjectId: item.subjectId,
        title: item.title,
        cover: item.cover,
        rating: item.rating,
        type: item.type
      }))
    });
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(503).json({ 
      error: "🎬 Service is temporarily unavailable. Try again in a few minutes, bro!" 
    });
  }
}
