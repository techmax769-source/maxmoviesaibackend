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
- Don't force Sheng if user is speaking pure English
- Don't force English if user is speaking Swahili

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
- Download app? Being developed - check countdown on Downloads page

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

function saveMemory(userId, memory) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf-8");
  } catch (err) {
    console.error(`Failed to save memory:`, err);
  }
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
        error: `⏰ Chill for ${rateCheck.waitTime} seconds, bro!` 
      });
    }

    let memory = loadMemory(userId);
    memory.conversation.push({ role: "user", content: prompt });

    const isCreatorQuestion = isAskingAboutCreator(prompt);
    const detectedLanguage = detectLanguage(prompt);
    
    let searchResults = [];
    
    // Extract search topic for recommendations
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

    // Special response for creator questions
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
- Match their exact vibe - if they use Sheng, use Sheng back
- If they use pure Swahili, respond in Swahili
- If they use English, respond in English
- DO NOT mix languages unnecessarily

RESPONSE STYLE:
- Be natural and conversational like a friend
- Use emojis naturally 🎬 🍿 🔥
- Be helpful and friendly
- When giving titles, use **bold**
- NEVER say "as an AI" or "language model"
- Be enthusiastic about recommendations

Answer the user's question naturally about entertainment or MaxMovies. Be friendly and match their language! 🎬
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
      // Return error message in user's language without emojis
      const errorMsg = detectedLanguage === 'swahili' 
        ? "Samahani! Server imejaa. Jaribu tena baadaye!"
        : "Whoops! Server busy. Try again later!";
      return res.status(503).json({ 
        reply: errorMsg,
        error: errorMsg 
      });
    }

    const result = await geminiResponse.json();
    let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!fullResponse) {
      const errorMsg = detectedLanguage === 'swahili' 
        ? "Samahani! Server imejaa. Jaribu tena baadaye!"
        : "Whoops! Server busy. Try again later!";
      return res.status(503).json({ 
        reply: errorMsg,
        error: errorMsg 
      });
    }

    // Clean up
    let cleanText = fullResponse.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    cleanText = cleanText.replace(/as an ai|as an AI|language model|i am an ai|i'm an ai/gi, '');
    cleanText = cleanText.replace(/Google/gi, '');
    cleanText = cleanText.replace(/Gemini/gi, 'MaxMovies AI');
    
    // Add clickable links for movie titles from search results
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
    // Return error message without emojis
    return res.status(503).json({ 
      reply: "Whoops! Server busy. Try again later!",
      error: "Whoops! Server busy. Try again later!" 
    });
  }
}
