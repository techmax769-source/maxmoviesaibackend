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

// 🔍 Search MaxMovies API
async function searchMaxMovies(query, limit = 6) {
  try {
    const searchUrl = `${MAXMOVIES_API}/search/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    let items = data?.results?.items || [];
    
    if (items.length === 0) return [];
    
    return items.slice(0, limit).map(item => {
      let type = 'movie';
      let typeDisplay = 'MOVIE';
      
      if (item.subjectType === 2) {
        type = 'series';
        typeDisplay = 'SERIES';
      } else if (item.subjectType === 3) {
        type = 'music';
        typeDisplay = 'MUSIC';
      }
      
      return {
        subjectId: item.subjectId,
        title: item.title || 'Untitled',
        cover: item.cover?.url || item.thumbnail || null,
        type: type,
        typeDisplay: typeDisplay,
        rating: item.imdbRatingValue || null,
        year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
      };
    });
    
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

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
      type: item.subjectType === 2 ? 'series' : 'movie',
      typeDisplay: item.subjectType === 2 ? 'SERIES' : 'MOVIE'
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
        content: `You are MaxMovies AI - a FUN movie expert!

RULES:
- Use **bold** around movie titles like **John Wick**
- Use emojis 🎬 🍿 🔥
- Keep it short and exciting
- Say if it's a MOVIE or SERIES`,
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

function extractSearchTopic(prompt) {
  let topic = prompt.replace(/what is|tell me about|info on|search for|find|look up|show me|recommend|suggest|best|good|top/gi, '');
  topic = topic.replace(/movie|series|film|show|about/gi, '');
  topic = topic.trim();
  if (topic.length < 2) return null;
  return topic;
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

    let searchResults = [];
    const searchTopic = extractSearchTopic(prompt);
    
    if (searchTopic && searchTopic.length > 2) {
      searchResults = await searchMaxMovies(searchTopic, 6);
    }
    
    if (searchResults.length === 0) {
      searchResults = await getTrending(6);
    }

    let searchContext = "";
    if (searchResults.length > 0) {
      searchContext = `\n\nFound these in database: ${JSON.stringify(searchResults)}\n\nRespond with SHORT, EXCITING info. Use **bold** around every title. Use emojis.`;
    }

    const promptText = `
User asked: "${prompt}"

${searchContext}

INSTRUCTIONS:
- Use **bold** around EVERY movie/series title like **Wrong Turn**
- Keep responses SHORT and EXCITING
- Use emojis 🎬 🍿 🔥
- Say if it's a MOVIE or SERIES

Example: "🎬 **John Wick** (MOVIE) - Pure adrenaline 🔥"

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
            maxOutputTokens: 500,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      return res.status(503).json({ 
        error: "🎬 Service is busy. Try again!" 
      });
    }

    const result = await geminiResponse.json();
    let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!fullResponse) {
      return res.status(503).json({ error: "🎬 No response. Try again!" });
    }

    // FIXED: Convert **text** to actual HTML bold
    let cleanText = fullResponse.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    cleanText = cleanText.replace(/as an ai|language model/gi, "");
    
    // Add clickable links for matching titles
    if (searchResults.length > 0) {
      searchResults.forEach(movie => {
        if (movie.title && movie.title.length > 2) {
          // Match the bolded title in the response
          const boldPattern = new RegExp(`<strong>${escapeRegex(movie.title)}</strong>`, 'gi');
          const link = `<a href="${SITE_URL}/#detail/${movie.subjectId}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${movie.title}</a> <span style="font-size: 0.7rem; color: #8b949e;">(${movie.typeDisplay})</span>`;
          cleanText = cleanText.replace(boldPattern, link);
        }
      });
    }
    
    memory.conversation.push({ role: "assistant", content: cleanText });
    
    if (memory.conversation.length > 20) {
      memory.conversation = memory.conversation.slice(-18);
    }
    
    saveMemory(userId, memory);

    return res.status(200).json({ 
      reply: cleanText,
      recommendations: searchResults.slice(0, 6).map(item => ({
        subjectId: item.subjectId,
        title: item.title,
        cover: item.cover,
        rating: item.rating,
        type: item.type,
        typeDisplay: item.typeDisplay
      }))
    });
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(503).json({ 
      error: "🎬 Service unavailable. Try again!" 
    });
  }
}
