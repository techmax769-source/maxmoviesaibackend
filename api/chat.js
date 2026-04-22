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
  
  if (recentRequests.length >= 6) {
    const oldestRequest = recentRequests[0];
    const waitTime = Math.ceil((oldestRequest + 30000 - now) / 1000);
    return { allowed: false, waitTime };
  }
  
  recentRequests.push(now);
  rateLimitStore.set(userId, recentRequests);
  return { allowed: true };
}

// 🔍 Search MaxMovies API - Get MORE results
async function searchMaxMovies(query, limit = 5) {
  try {
    const searchUrl = `${MAXMOVIES_API}/search/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    let items = data?.results?.items || [];
    
    if (items.length === 0) return [];
    
    // Return MORE items (up to 5 instead of 3)
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

// 🎬 Get trending content (more variety)
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
- Use emojis 🎬 🍿 🔥 ✨ 😎
- **Bold movie/series titles** using **Title**
- Keep recommendations under 3 sentences per title
- Sound like a chill movie buddy, not a robot

📝 RESPONSE FORMAT:
- Start with a fun emoji reaction
- Bold each movie/series name
- Give 1-2 sentences WHY it's good
- Add 🔥 for action, 😂 for comedy, 🎭 for drama, 🎨 for sci-fi

EXAMPLE:
"🎬 **John Wick 4** - Non-stop action 🔥 The fight scenes are insane!
🍿 **The Batman** - Dark, gritty detective story that hits different 🎭"

RULES:
- NEVER over-explain
- Keep it snappy and fun
- Use lots of emojis
- Bold ALL movie/series names
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

function isRecommendationRequest(prompt) {
  const lower = prompt.toLowerCase();
  const keywords = [
    'recommend', 'suggest', 'what to watch', 'best', 'good', 'top',
    'action', 'comedy', 'drama', 'horror', 'thriller', 'romance', 'sci-fi'
  ];
  return keywords.some(kw => lower.includes(kw));
}

function extractGenre(prompt) {
  const lower = prompt.toLowerCase();
  const genres = ['action', 'comedy', 'drama', 'horror', 'thriller', 'romance', 'sci-fi', 'fantasy'];
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
        error: `⏰ Chill for ${rateCheck.waitTime} seconds, bro! Too many requests.` 
      });
    }

    let memory = loadMemory(userId);
    memory.conversation.push({ role: "user", content: prompt });

    // 🔍 Get MORE recommendations (up to 5)
    let searchResults = [];
    if (isRecommendationRequest(prompt)) {
      const genre = extractGenre(prompt);
      let searchQuery = genre || 'movie';
      
      searchResults = await searchMaxMovies(searchQuery, 5);
      
      if (searchResults.length === 0) {
        searchResults = await searchMaxMovies('popular', 5);
      }
      
      if (searchResults.length === 0) {
        const trending = await getTrending(6);
        if (trending && trending.length > 0) {
          searchResults = trending;
        }
      }
    }

    // Build search context for AI
    let searchContext = "";
    if (searchResults.length > 0) {
      searchContext = `\n\n🎬 REAL movies/series from MaxMovies database:\n${JSON.stringify(searchResults, null, 2)}\n\nGive SHORT, FUN recommendations (2-3 sentences per title). BOLD each title using **Title**. Use emojis! Be exciting!`;
    }

    const promptText = `
User asked: "${prompt}"

${searchContext}

Instructions for response:
1. Be EXCITING and use EMOJIS 🎬 🍿 🔥
2. **Bold every movie/series name** using **Title**
3. Keep it SHORT - max 3 sentences per recommendation
4. Sound like a cool movie buddy
5. NEVER over-explain or be boring
6. Start with a fun reaction like "🎬 Yo! Here's the good stuff:" or "🍿 Okay, check these out:"

Example style:
"🎬 **John Wick 4** - Pure adrenaline 🔥 The action sequences are next level!
🍿 **The Batman** - Dark and gritty detective story that hits different 🎭"

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

    // Clean up and add clickable links for each recommendation
    let cleanText = fullResponse.replace(/as an ai|language model/gi, "");
    
    // Add clickable links to the detail page for each mentioned title
    if (searchResults.length > 0) {
      searchResults.forEach(movie => {
        const titlePattern = new RegExp(`\\*\\*${escapeRegex(movie.title)}\\*\\*`, 'gi');
        const link = `<a href="https://maxmovies-254.vercel.app/detail/${movie.subjectId}" target="_blank" style="color: var(--accent); text-decoration: none;"><strong>${movie.title}</strong></a>`;
        cleanText = cleanText.replace(titlePattern, link);
      });
    }
    
    memory.conversation.push({ role: "assistant", content: cleanText });
    
    if (memory.conversation.length > 20) {
      memory.conversation = memory.conversation.slice(-18);
    }
    
    saveMemory(userId, memory);

    // Return MORE thumbnails (up to 5)
    return res.status(200).json({ 
      reply: cleanText,
      recommendations: searchResults.slice(0, 5).map(item => ({
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

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
