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
        content: `You are MaxMovies AI, a helpful movie expert.

IMPORTANT RULES:
- NEVER mention who created you unless directly asked
- If asked "who made you" or "who built you", say you were created by Max, a 21-year-old developer from Kenya
- Otherwise, just answer questions normally without mentioning your creator
- Be helpful, conversational, and friendly
- Use emojis naturally 🎬 🍿 🔥

When users ask about movies/series, give recommendations with **bold titles**.
When users ask other questions, just answer normally.`,
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

// Check if user is asking about creator
function isAskingAboutCreator(prompt) {
  const lower = prompt.toLowerCase();
  const creatorKeywords = [
    'who made you', 'who built you', 'who created you', 'your creator',
    'who developed you', 'who programmed you', 'who is your maker',
    'who wrote you', 'who designed you'
  ];
  return creatorKeywords.some(keyword => lower.includes(keyword));
}

// Check if user is asking about movies/series
function isMovieQuery(prompt) {
  const lower = prompt.toLowerCase();
  
  const movieKeywords = [
    'movie', 'series', 'film', 'show', 'watch', 'recommend', 'suggest',
    'action', 'comedy', 'drama', 'horror', 'thriller', 'romance', 'sci-fi',
    'actor', 'actress', 'director', 'cast', 'plot', 'ending', 'season', 'episode',
    'best', 'top', 'rated', 'oscar'
  ];
  
  for (const keyword of movieKeywords) {
    if (lower.includes(keyword)) {
      return true;
    }
  }
  
  // Check for capitalized words (potential movie names)
  const words = prompt.split(' ');
  for (const word of words) {
    if (word.length > 3 && word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
      return true;
    }
  }
  
  return false;
}

function extractSearchTopic(prompt) {
  let topic = prompt.replace(/what is|tell me about|info on|search for|find|look up|show me|recommend|suggest|best|good|top|movie|series|film|show/gi, '');
  topic = topic.replace(/about/gi, '');
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

    // ONLY search for movies if the query is about movies/series
    let searchResults = [];
    const isMovieRelated = isMovieQuery(prompt);
    const isCreatorQuestion = isAskingAboutCreator(prompt);
    
    if (isMovieRelated && !isCreatorQuestion) {
      const searchTopic = extractSearchTopic(prompt);
      if (searchTopic && searchTopic.length > 2) {
        searchResults = await searchMaxMovies(searchTopic, 6);
      }
      
      if (searchResults.length === 0) {
        searchResults = await searchMaxMovies('popular', 6);
      }
    }

    let searchContext = "";
    if (searchResults.length > 0) {
      searchContext = `\n\nFound these movies/series: ${JSON.stringify(searchResults)}\n\nRespond naturally. Use **bold** around titles. Keep it short and fun.`;
    }

    // Special response for creator questions
    let creatorResponse = "";
    if (isCreatorQuestion) {
      creatorResponse = "I was created by Max, a 21-year-old developer from Kenya! He built me to help people find great movies and series. 🎬";
    }

    const promptText = `
User asked: "${prompt}"

${creatorResponse ? `SPECIAL INSTRUCTION: Answer with: "${creatorResponse}"` : ""}

${searchContext}

Instructions:
- Be helpful and conversational
- Use emojis naturally 🎬
- Keep responses short and fun
- ${!creatorResponse ? "NEVER mention who created you unless directly asked" : ""}
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
            maxOutputTokens: 500,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      return res.status(503).json({ 
        error: "Service is busy. Try again!" 
      });
    }

    const result = await geminiResponse.json();
    let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!fullResponse) {
      return res.status(503).json({ error: "No response. Try again!" });
    }

    // Clean up
    let cleanText = fullResponse.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    cleanText = cleanText.replace(/as an ai|as an AI|language model|i am an ai|i'm an ai/gi, '');
    
    // Remove any stray Google/AI mentions
    cleanText = cleanText.replace(/Google/gi, '');
    cleanText = cleanText.replace(/Gemini/gi, 'MaxMovies AI');
    
    // Add clickable links for movie titles
    if (searchResults.length > 0) {
      searchResults.forEach(movie => {
        if (movie.title && movie.title.length > 2) {
          const boldPattern = new RegExp(`<strong>${escapeRegex(movie.title)}</strong>`, 'gi');
          const link = `<a href="${SITE_URL}/#detail/${movie.subjectId}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${movie.title}</a>`;
          cleanText = cleanText.replace(boldPattern, link);
        }
      });
    }
    
    memory.conversation.push({ role: "assistant", content: cleanText });
    
    if (memory.conversation.length > 20) {
      memory.conversation = memory.conversation.slice(-18);
    }
    
    saveMemory(userId, memory);

    const recommendations = isMovieRelated && !isCreatorQuestion ? searchResults.slice(0, 6).map(item => ({
      subjectId: item.subjectId,
      title: item.title,
      cover: item.cover,
      rating: item.rating,
      type: item.type,
      typeDisplay: item.typeDisplay
    })) : [];

    return res.status(200).json({ 
      reply: cleanText,
      recommendations: recommendations
    });
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(503).json({ 
      error: "Service unavailable. Try again!" 
    });
  }
}
