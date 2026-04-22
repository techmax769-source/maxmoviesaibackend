import fs from "fs";
import path from "path";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
const MAXMOVIES_API = "https://maxmoviesbackend.vercel.app/api/v2";
const SITE_URL = "https://maxmovies-254.vercel.app";

const MEMORY_DIR = "/tmp/memory";
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR);

// Better rate limiting - more generous limits
const rateLimitStore = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = rateLimitStore.get(userId) || [];
  
  // Clean old requests (older than 60 seconds)
  const recentRequests = userRequests.filter(timestamp => now - timestamp < 60000);
  
  // Allow 15 requests per minute (more reasonable)
  if (recentRequests.length >= 15) {
    const oldestRequest = recentRequests[0];
    const waitTime = Math.ceil((oldestRequest + 60000 - now) / 1000);
    return { allowed: false, waitTime };
  }
  
  recentRequests.push(now);
  rateLimitStore.set(userId, recentRequests);
  
  // Clean up old entries every 5 minutes
  if (Math.random() < 0.01) {
    for (const [uid, timestamps] of rateLimitStore.entries()) {
      const fresh = timestamps.filter(t => now - t < 60000);
      if (fresh.length === 0) {
        rateLimitStore.delete(uid);
      } else {
        rateLimitStore.set(uid, fresh);
      }
    }
  }
  
  return { allowed: true };
}

// 🔍 Search MaxMovies API with caching
const searchCache = new Map();

async function searchMaxMovies(query, limit = 6) {
  const cacheKey = `${query}_${limit}`;
  
  // Check cache first (5 minute TTL)
  if (searchCache.has(cacheKey)) {
    const { data, timestamp } = searchCache.get(cacheKey);
    if (Date.now() - timestamp < 300000) { // 5 minutes
      return data;
    }
    searchCache.delete(cacheKey);
  }
  
  try {
    const searchUrl = `${MAXMOVIES_API}/search/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    let items = data?.results?.items || [];
    
    if (items.length === 0) return [];
    
    const results = items.slice(0, limit).map(item => {
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
    
    // Store in cache
    searchCache.set(cacheKey, { data: results, timestamp: Date.now() });
    
    return results;
    
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

// Optimized memory loading with error recovery
function loadMemory(userId) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      const memory = JSON.parse(data);
      
      // Limit conversation history to prevent memory bloat
      if (memory.conversation && memory.conversation.length > 15) {
        memory.conversation = memory.conversation.slice(-15);
      }
      
      return memory;
    }
  } catch (err) {
    console.error(`Failed to load memory:`, err);
    // If memory is corrupted, delete it and start fresh
    try {
      fs.unlinkSync(filePath);
    } catch(e) {}
  }

  return {
    userId,
    conversation: [
      {
        role: "system",
        content: `You are MaxMovies AI, a jovial entertainment buddy who knows everything about MaxMovies website.

🚨 YOUR IDENTITY & PERSONALITY:
- Name: MaxMovies AI (never call yourself anything else)
- Personality: Jovial, friendly, conversational
- Use emojis naturally: 🎬 🍿 🔥 💯 😎 🙌 💪 🎵
- NEVER use formal/robotic language - be natural like a friend
- NEVER say "as an AI" or "language model" - just be natural

🎯 LANGUAGE MATCHING (CRITICAL):
- If user speaks English → respond in English
- If user speaks Swahili → respond in Swahili
- If user speaks Sheng → respond in Sheng
- Match their vibe and slang exactly

📌 WHAT YOU KNOW ABOUT MAXMOVIES WEBSITE:

Website Name: MaxMovies
Tagline: Premium Stream/Download
URL: ${SITE_URL}

FEATURES:
- Stream movies and TV series in HD (360p to 1080p)
- Download content for offline (dedicated app with download manager coming soon!)
- Music Zone with 9 genres: Classical, Reggaetone, RnB, Arbantone, Gengetone, Afro Beats, Pop, Gospel, Instrumental
- Live TV channels
- Personal library to save favorites
- Search for movies, series, and music
- Recently watched tracking
- Season/episode management for series
- Multiple quality options
- Subtitle support
- Trending Now section
- Upcoming releases

HOW TO USE:
- Streaming: Click any card → Stream button → Pick quality
- Downloads: Same as stream but click Download (opens in new tab for now)
- Music: Click Music Zone from menu → Pick genre or search
- Library: Click 'My List' button on any content
- Search: Use search bar at top
- Continue watching: Progress saves automatically!

FAQ:
- Free? YES! 100% free, no subscription, no account needed
- Account? No account required - everything saves in browser
- App? Coming soon! Check Downloads page for countdown
- Subtitles? Yes, look for Subtitles button in player

MUSIC GENRES DETAILS:
Classical 🎻, Reggaetone 🎤, RnB 🎸, Arbantone 🎧, Gengetone 🥁, Afro Beats 🪘, Pop 🎹, Gospel 🙏, Instrumental 🎺

RESPONSE STYLE:
- Be natural and conversational
- Match user's language (English/Swahili/Sheng)
- Be helpful and friendly
- When giving movie titles, put them in **bold**
- Be enthusiastic about recommendations

ABOUT YOUR CREATOR (only answer if directly asked):
If asked "who made you" or "who created you", say: "I was created by Max, a 21-year-old developer from Kenya! 🎬"

NEVER volunteer creator info unless asked directly.

Be helpful, natural, and match the user's language vibe! 🍿`,
      },
    ],
  };
}

// Throttled memory saving - don't save on every request
const saveQueue = new Map();
let saveTimeout = null;

function saveMemory(userId, memory) {
  // Queue the save instead of doing it immediately
  saveQueue.set(userId, memory);
  
  if (saveTimeout) clearTimeout(saveTimeout);
  
  saveTimeout = setTimeout(() => {
    for (const [uid, mem] of saveQueue.entries()) {
      const filePath = path.join(MEMORY_DIR, `memory_${uid}.json`);
      try {
        // Limit conversation size before saving
        if (mem.conversation && mem.conversation.length > 15) {
          mem.conversation = mem.conversation.slice(-15);
        }
        fs.writeFileSync(filePath, JSON.stringify(mem, null, 2), "utf-8");
      } catch (err) {
        console.error(`Failed to save memory:`, err);
      }
    }
    saveQueue.clear();
    saveTimeout = null;
  }, 3000); // Save after 3 seconds of inactivity
}

// Detect language of the prompt
function detectLanguage(prompt) {
  const swahiliWords = ['habari', 'asante', 'sawa', 'tafadhali', 'ndiyo', 'hapana', 'karibu', 'pole', 'samahani', 'kwaheri', 'jina', 'rafiki', 'mambo', 'vipi', 'sasa', 'nini', 'kumbe', 'sijui', 'mbaya', 'freshi', 'tamu', 'choma', 'mchele', 'fiti', 'safi', 'poa', 'kuu', 'kabisa', 'mzuka', 'kubwa', 'bana', 'wacha'];
  
  const lowerPrompt = prompt.toLowerCase();
  let swahiliCount = 0;
  
  for (const word of swahiliWords) {
    if (lowerPrompt.includes(word)) {
      swahiliCount++;
    }
  }
  
  if (swahiliCount >= 2) {
    return 'swahili';
  }
  
  return 'english';
}

// Check if user is asking about creator
function isAskingAboutCreator(prompt) {
  const lower = prompt.toLowerCase();
  const creatorKeywords = [
    'who made you', 'who built you', 'who created you', 'your creator',
    'who developed you', 'who programmed you', 'who is your maker',
    'who wrote you', 'who designed you', 'who made maxmovies ai',
    'uliundwa na nani', 'nani aliyekutengeneza'
  ];
  return creatorKeywords.some(keyword => lower.includes(keyword));
}

function extractSearchTopic(prompt) {
  let topic = prompt.replace(/what is|tell me about|info on|search for|find|look up|show me|recommend|suggest|best|good|top|movie|series|film|show|nipe|tazama|onyesha|tafuta/gi, '');
  topic = topic.replace(/about|kuhusu/gi, '');
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
        error: `⏰ Take a ${rateCheck.waitTime} sec break! Too many messages.`
      });
    }

    let memory = loadMemory(userId);
    memory.conversation.push({ role: "user", content: prompt });

    const isCreatorQuestion = isAskingAboutCreator(prompt);
    const detectedLanguage = detectLanguage(prompt);
    
    let searchResults = [];
    
    const searchTopic = extractSearchTopic(prompt);
    if (searchTopic && searchTopic.length > 2 && !isCreatorQuestion) {
      searchResults = await searchMaxMovies(searchTopic, 6);
    }
    
    if (searchResults.length === 0 && !isCreatorQuestion) {
      searchResults = await searchMaxMovies('popular', 6);
    }

    let searchContext = "";
    if (searchResults.length > 0) {
      searchContext = `\n\nFound these from MaxMovies: ${JSON.stringify(searchResults)}\n\nRespond naturally. Use **bold** around titles. Match user's language (${detectedLanguage === 'swahili' ? 'respond in Swahili/Sheng' : 'respond in English'}). Keep it friendly.`;
    }

    let creatorResponse = "";
    if (isCreatorQuestion) {
      if (detectedLanguage === 'swahili') {
        creatorResponse = "Niliundwa na Max, developer wa miaka 21 kutoka Kenya! 🎬";
      } else {
        creatorResponse = "I was created by Max, a 21-year-old developer from Kenya! 🎬";
      }
    }

    const promptText = `
User asked: "${prompt}"

Detected language: ${detectedLanguage === 'swahili' ? 'Swahili/Sheng' : 'English'}

${creatorResponse ? `SPECIAL INSTRUCTION: Answer with EXACTLY this: "${creatorResponse}"` : ""}

${searchContext}

WEBSITE INFO (MaxMovies):
- Name: MaxMovies - Premium Stream/Download
- URL: ${SITE_URL}
- Features: Streaming (360p-1080p), Downloads (app coming), Music Zone (9 genres), Live TV, Library, Search
- Music Genres: Classical, Reggaetone, RnB, Arbantone, Gengetone, Afro Beats, Pop, Gospel, Instrumental
- Free? YES! No account needed
- App: Coming soon - check Downloads page

CRITICAL INSTRUCTION FOR LANGUAGE:
- User is speaking ${detectedLanguage === 'swahili' ? 'Swahili/Sheng' : 'English'}
- YOU MUST RESPOND IN ${detectedLanguage === 'swahili' ? 'SWAHILI/SHENG' : 'ENGLISH'}
- Match their exact vibe
- DO NOT mix languages unnecessarily

RESPONSE STYLE:
- Be natural and conversational like a friend
- Use emojis naturally 🎬 🍿 🔥
- Be helpful and friendly
- When giving titles, use **bold**
- NEVER say "as an AI" or "language model"

Answer the user's question naturally about entertainment or MaxMovies. Be friendly and match their language! 🎬
`;

    // Call Gemini API with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
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
        signal: controller.signal,
      }
    );
    
    clearTimeout(timeoutId);

    if (!geminiResponse.ok) {
      console.error(`Gemini API error: ${geminiResponse.status}`);
      const errorMsg = detectedLanguage === 'swahili' 
        ? "Samahani! Server imejaa. Jaribu tena baadaye!"
        : "Whoops! Server busy. Try again later!";
      
      // Save memory even on error
      saveMemory(userId, memory);
      
      return res.status(503).json({ 
        reply: errorMsg,
        recommendations: searchResults.slice(0, 6)
      });
    }

    const result = await geminiResponse.json();
    let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!fullResponse) {
      const errorMsg = detectedLanguage === 'swahili' 
        ? "Samahani! Hakuna majibu. Jaribu tena!"
        : "Sorry! No response. Try again!";
      
      saveMemory(userId, memory);
      
      return res.status(503).json({ 
        reply: errorMsg,
        recommendations: searchResults.slice(0, 6)
      });
    }

    // Clean up
    let cleanText = fullResponse.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    cleanText = cleanText.replace(/as an ai|as an AI|language model|i am an ai|i'm an ai/gi, '');
    cleanText = cleanText.replace(/Google/gi, '');
    cleanText = cleanText.replace(/Gemini/gi, 'MaxMovies AI');
    
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
    
    // Limit conversation size
    if (memory.conversation.length > 15) {
      memory.conversation = memory.conversation.slice(-15);
    }
    
    // Throttled save
    saveMemory(userId, memory);

    const recommendations = searchResults.slice(0, 6).map(item => ({
      subjectId: item.subjectId,
      title: item.title,
      cover: item.cover,
      rating: item.rating,
      type: item.type,
      typeDisplay: item.typeDisplay
    }));

    return res.status(200).json({ 
      reply: cleanText,
      recommendations: recommendations
    });
    
  } catch (err) {
    console.error("Server error:", err);
    
    // Handle timeout errors specifically
    if (err.name === 'AbortError') {
      return res.status(503).json({ 
        reply: "Request timeout! Try again.",
        error: "Timeout"
      });
    }
    
    return res.status(503).json({ 
      reply: "Whoops! Server busy. Try again later!",
      error: err.message 
    });
  }
}
