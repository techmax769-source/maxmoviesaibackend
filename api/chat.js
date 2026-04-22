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
        content: `You are MaxMovies AI, a jovial movie buddy who knows everything about MaxMovies website.

🚨 YOUR IDENTITY & PERSONALITY:
- Name: MaxMovies AI (never call yourself anything else)
- Personality: Jovial, friendly, uses Sheng (Kenyan slang) and informal English
- Use emojis freely: 🎬 🍿 🔥 💯 😎 🙌 💪 🎵
- NEVER use formal/robotic language - be casual like a friend
- NEVER say "as an AI" or "language model" - just be natural

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

RESPONSE STYLE RULES:
- Be jovial and fun! Use phrases like: "Sasa!", "Vipi mtu!", "Fiti!", "Safi!", "Kuu!", "Kabisa!"
- Mix Sheng and informal English naturally
- Use emojis to express energy
- Keep responses conversational, not robotic
- NEVER use formal greetings like "Greetings" or "Hello, I am"
- Start naturally: "Yo!", "Sasa!", "Vipi!", "Hey!"
- When giving movie titles, put them in **bold**
- For recommendations, be enthusiastic: "Let me put you on! 🔥"

WEBSITE-ONLY RULE:
If asked about anything NOT related to MaxMovies (sports, news, politics, random facts, etc.), politely redirect:
"Eh, I'm strictly MaxMovies AI fam! I only know about movies, series, music, and everything on MaxMovies. 🎬 Ask me about what to watch or how to use the site!"

ABOUT YOUR CREATOR (only answer if directly asked):
If asked "who made you" or "who created you", say: "I was created by Max, a 21-year-old developer from Kenya! He built me to be your movie buddy. 🎬"

NEVER volunteer creator info unless asked directly.

Be helpful, energetic, and make every conversation feel like talking to a friend who loves movies! 🍿`,
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
    'who wrote you', 'who designed you', 'who made maxmovies ai'
  ];
  return creatorKeywords.some(keyword => lower.includes(keyword));
}

// Check if query is about the website
function isWebsiteRelated(prompt) {
  const lower = prompt.toLowerCase();
  
  const websiteKeywords = [
    'maxmovies', 'movie', 'series', 'film', 'show', 'watch', 'recommend', 
    'suggest', 'action', 'comedy', 'drama', 'horror', 'thriller', 'romance', 
    'sci-fi', 'actor', 'actress', 'director', 'cast', 'plot', 'season', 
    'episode', 'best', 'top', 'rated', 'oscar', 'download', 'stream', 
    'quality', 'subtitle', 'library', 'music', 'live tv', 'channel',
    'free', 'account', 'sign up', 'login', 'app', 'how to', 'help',
    'trending', 'upcoming', 'release', 'kenyan', 'afro', 'reggaetone', 
    'arbantone', 'gengetone', 'rnb', 'classical', 'pop', 'gospel', 'instrumental',
    'my list', 'continue watching', 'recently watched'
  ];
  
  for (const keyword of websiteKeywords) {
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

// Check if user is asking about movies/series specifically
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

    // Check if query is website-related
    const isWebsiteRelatedQuery = isWebsiteRelated(prompt);
    const isMovieRelated = isMovieQuery(prompt);
    const isCreatorQuestion = isAskingAboutCreator(prompt);
    
    let searchResults = [];
    
    // ONLY search for movies if the query is about movies AND website-related
    if (isWebsiteRelatedQuery && isMovieRelated && !isCreatorQuestion) {
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
      searchContext = `\n\nFound these movies/series from MaxMovies: ${JSON.stringify(searchResults)}\n\nRespond naturally. Use **bold** around titles. Keep it short, fun, and use Sheng/emoji vibes.`;
    }

    // Special response for creator questions
    let creatorResponse = "";
    if (isCreatorQuestion) {
      creatorResponse = "I was created by Max, a 21-year-old developer from Kenya! He built me to be your movie buddy. 🎬";
    }

    // Redirect non-website queries
    let redirectResponse = "";
    if (!isWebsiteRelatedQuery && !isCreatorQuestion) {
      redirectResponse = "Eh, I'm strictly MaxMovies AI fam! I only know about movies, series, music, and everything on MaxMovies. 🎬\n\nAsk me about:\n• What to watch 🍿\n• How to stream/download 📥\n• Music Zone 🎵\n• Live TV 📺\n• Or just vibes about entertainment!\n\nWhat movie or series you looking for today? 😎";
    }

    const promptText = `
User asked: "${prompt}"

${redirectResponse ? `IMPORTANT: The user asked about something NOT related to MaxMovies. Answer with EXACTLY this: "${redirectResponse}"` : ""}

${creatorResponse ? `SPECIAL INSTRUCTION: Answer with: "${creatorResponse}"` : ""}

${searchContext}

WEBSITE CONTEXT (only relevant if user asks about MaxMovies features):
- Name: MaxMovies - Premium Stream/Download
- URL: ${SITE_URL}
- Features: Streaming (360p-1080p), Downloads (app coming), Music Zone (9 genres), Live TV, Library, Search
- Music Genres: Classical, Reggaetone, RnB, Arbantone, Gengetone, Afro Beats, Pop, Gospel, Instrumental
- Free? YES! No account needed
- App: Coming soon - check Downloads page

RESPONSE STYLE REQUIREMENTS:
- Be JOVIAL and FRIENDLY (like a movie buddy)
- Use SHENG and informal English: "Sasa!", "Vipi!", "Fiti!", "Safi!", "Kuu!", "Kabisa!"
- Use EMOJIS: 🎬 🍿 🔥 💯 😎 🙌 💪 🎵 🎶
- NEVER be formal or robotic
- NEVER say "as an AI" or "language model"
- Keep responses conversational and energetic
- When giving movie titles, put them in **bold**
- Be enthusiastic about recommendations: "Let me put you on! 🔥"

${!redirectResponse && !creatorResponse ? "Answer the user's question naturally about movies, series, or MaxMovies features. Be jovial and fun!" : ""}
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
      // Return the exact error message without emojis as requested
      return res.status(503).json({ 
        reply: "Whoops! Server busy. Try again later!",
        error: "Whoops! Server busy. Try again later!" 
      });
    }

    const result = await geminiResponse.json();
    let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!fullResponse) {
      return res.status(503).json({ 
        reply: "Whoops! Server busy. Try again later!",
        error: "Whoops! Server busy. Try again later!" 
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

    const recommendations = (isWebsiteRelatedQuery && isMovieRelated && !isCreatorQuestion) ? searchResults.slice(0, 6).map(item => ({
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
    // Return exact error message without emojis as requested
    return res.status(503).json({ 
      reply: "Whoops! Server busy. Try again later!",
      error: "Whoops! Server busy. Try again later!" 
    });
  }
}
