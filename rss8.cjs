const { telegram_rss } = require('telegram-rss');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { parseStringPromise, Builder } = require('xml2js');

// Configure HTTP and HTTPS agents with keepAlive
http.globalAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 10
});

https.globalAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000,
    maxSockets: 10
});

// Create images directory if it doesn't exist
const imageDir = path.join(__dirname, 'images');
if (!fs.existsSync(imageDir)) {
    fs.mkdirSync(imageDir);
}

// Cache object to store RSS data
let rssCache = new Map();

// Function to get random interval between 10-15 minutes in milliseconds
function getRandomInterval() {
    return (Math.floor(Math.random() * (15 - 10 + 1)) + 10) * 60 * 1000;
}

// Function to sanitize text for XML
function sanitizeXmlText(text) {
    if (!text) return "";
    return text
        .replace(/&(?!(amp;|lt;|gt;|quot;|apos;))/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD]/g, '')
        .trim();
}

// Function to parse date with fallback
function parseDate(dateStr) {
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? new Date() : parsed;
}

// Extract post number from Telegram link
function extractPostNumber(link) {
    try {
        const matches = link.match(/\/(\d+)$/);
        return matches ? parseInt(matches[1]) : 0;
    } catch (error) {
        console.error("Error extracting post number:", error);
        return 0;
    }
}

// Simple MIME type detection from magic numbers
function detectMimeType(buffer) {
    const signatures = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/gif': [0x47, 0x49, 0x46, 0x38],
        'image/webp': [0x52, 0x49, 0x46, 0x46]
    };

    for (const [mimeType, signature] of Object.entries(signatures)) {
        if (signature.every((byte, index) => buffer[index] === byte)) {
            return mimeType;
        }
    }
    return 'image/jpeg'; // default fallback
}

// Function to get file extension from MIME type
function getExtFromMime(mimeType) {
    const extensions = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp'
    };
    return extensions[mimeType] || '.jpg';
}

// Function to ensure directory exists
function ensureDirectoryExists(directory) {
    if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return directory;
}

// Function to download image and get its metadata with retry logic
async function downloadImage(imageUrl, channel, postNumber, retries = 3, delay = 2000) {
    // Create directory structure: images/channel/postNumber
    const channelDir = ensureDirectoryExists(path.join(imageDir, channel));
    const postDir = ensureDirectoryExists(path.join(channelDir, postNumber.toString()));
    
    // Check if an image already exists in this post directory
    const existingFiles = fs.readdirSync(postDir);
    if (existingFiles.length > 0) {
        // Image already exists, return the info for the existing image
        const existingFile = existingFiles[0];
        const filePath = path.join(postDir, existingFile);
        const stats = fs.statSync(filePath);
        const buffer = fs.readFileSync(filePath);
        const mimeType = detectMimeType(buffer);
        
        return {
            path: filePath,
            filename: existingFile,
            size: stats.size,
            mimeType: mimeType,
            relativePath: path.join('images', channel, postNumber.toString(), existingFile)
        };
    }
    
    // No existing image, download new one with retries
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const req = https.get(imageUrl, { timeout: 30000 }, (response) => {
                    if (response.statusCode !== 200) {
                        reject(new Error(`Failed to download image: ${response.statusCode}`));
                        return;
                    }

                    const chunks = [];
                    response.on('data', chunk => chunks.push(chunk));
                    
                    response.on('end', () => {
                        try {
                            const buffer = Buffer.concat(chunks);
                            const mimeType = detectMimeType(buffer);
                            const ext = getExtFromMime(mimeType);
                            const filename = `image${ext}`;  // Simple filename: image.jpg, image.png, etc.
                            const filepath = path.join(postDir, filename);

                            // Write file
                            fs.writeFileSync(filepath, buffer);

                            resolve({
                                path: filepath,
                                filename: filename,
                                size: buffer.length,
                                mimeType: mimeType,
                                relativePath: path.join('images', channel, postNumber.toString(), filename)
                            });
                        } catch (error) {
                            reject(error);
                        }
                    });

                    response.on('error', reject);
                });
                
                req.on('error', reject);
                
                // Add timeout handling
                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timeout'));
                });
            });
        } catch (error) {
            if (attempt === retries - 1) {
                console.error(`Failed to download image after ${retries} attempts: ${error.message}`);
                throw error;
            }
            console.log(`Retrying download for ${imageUrl} (attempt ${attempt + 1}/${retries}): ${error.message}`);
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt)));
        }
    }
}

// Function to safely fetch RSS data from telegram-rss with retry
async function safeTelegramRss(telegram_channel, retries = 3, delay = 2000) {
    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            const result = await telegram_rss(telegram_channel);
            return result;
        } catch (error) {
            if (attempt === retries - 1) {
                console.error(`Failed to fetch telegram RSS after ${retries} attempts: ${error.message}`);
                throw error;
            }
            console.log(`Retrying telegram-rss fetch (attempt ${attempt + 1}/${retries}): ${error.message}`);
            // Wait before retrying with exponential backoff
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, attempt)));
        }
    }
}

// Function to process RSS feed
async function processRssFeed(telegram_channel, serverUrl) {
    try {
        let result = await safeTelegramRss(telegram_channel);
        
        // Pre-sanitize the XML string before parsing
        result = result.replace(/&(?![a-zA-Z0-9#]+;)/g, '&amp;');
        
        let parsedData = await parseStringPromise(result);
        let channel = parsedData.rss.channel[0];
        let realChannelTitle = sanitizeXmlText(channel.title[0]) || "Telegram Channel";
        channel.title = [realChannelTitle];
        channel.link = [`https://t.me/${telegram_channel}`];
        channel.description = [""];
        let latestPubDate = new Date().toUTCString();
        channel.pubDate = [latestPubDate];
        channel.lastBuildDate = [latestPubDate];
        channel["atom:link"] = [{ $: { rel: "self", type: "application/rss+xml", href: "" } }];

        // Process and collect all items
        let items = await Promise.all(channel.item.map(async item => {
            let imageUrl = item.image ? item.image[0].url[0] : "";
            let pubDate = item.pubDate && item.pubDate[0] ? new Date(item.pubDate[0]).toUTCString() : latestPubDate;
            let postLink = item.link[0];
            let postNumber = extractPostNumber(postLink);
            let descriptionText = sanitizeXmlText(item.description ? item.description[0] : item.title[0]);

            let enclosure = [];
            if (imageUrl) {
                try {
                    const imageData = await downloadImage(imageUrl, telegram_channel, postNumber);
                    const localImageUrl = `${serverUrl}/${imageData.relativePath}`;
                    
                    enclosure = [{
                        $: {
                            url: localImageUrl,
                            type: imageData.mimeType,
                            length: imageData.size.toString()
                        }
                    }];
                } catch (error) {
                    console.error("Error downloading image:", error);
                    // Fallback to original image URL on failure
                    enclosure = [{
                        $: {
                            url: imageUrl,
                            type: "image/jpeg",
                            length: "0"
                        }
                    }];
                }
            }

            return {
                title: ["[Photo]"],
                description: [descriptionText],
                pubDate: [pubDate],
                link: [postLink],
                guid: [postLink],
                enclosure: enclosure,
                _postNumber: postNumber // Add post number for sorting
            };
        }));

        // Sort items by post number (newest first)
        items.sort((a, b) => b._postNumber - a._postNumber);

        // Remove the _postNumber field before building XML
        items.forEach(item => delete item._postNumber);
        
        // Assign sorted items back to channel
        channel.item = items;

        let builder = new Builder({
            headless: true,
            xmldec: { version: "1.0", encoding: "UTF-8" },
            renderOpts: { pretty: true }
        });
        
        let newXml = builder.buildObject({ rss: { $: { "xmlns:atom": "http://www.w3.org/2005/Atom", version: "2.0" }, channel } });
        
        // Update cache
        rssCache.set(telegram_channel, {
            xml: newXml,
            lastUpdate: new Date()
        });

        return newXml;
    } catch (error) {
        console.error("Error processing RSS:", error);
        throw error;
    }
}

// Function to start timer for a channel with improved error handling
function startChannelTimer(channel, serverUrl) {
    const updateRss = async () => {
        let retries = 3;
        let success = false;
        let nextInterval;
        
        for (let attempt = 0; attempt < retries && !success; attempt++) {
            try {
                await processRssFeed(channel, serverUrl);
                console.log(`RSS updated for channel ${channel} at ${new Date().toISOString()}`);
                success = true;
                
                // Schedule next update with random interval
                nextInterval = getRandomInterval();
                console.log(`Next update scheduled in ${nextInterval/60000} minutes`);
            } catch (error) {
                console.error(`Error updating RSS for channel ${channel} (attempt ${attempt + 1}/${retries}):`, error);
                if (attempt < retries - 1) {
                    // Wait before retry (exponential backoff)
                    const retryDelay = 1000 * Math.pow(2, attempt);
                    console.log(`Retrying in ${retryDelay/1000} seconds...`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    // All retries failed, schedule next update sooner
                    nextInterval = 60000; // 1 minute
                    console.log(`All retries failed. Next attempt in ${nextInterval/60000} minutes`);
                }
            }
        }
        
        // Schedule the next update
        setTimeout(() => updateRss(), nextInterval || 60000);
    };

    // Start the initial update
    updateRss();
}

const serverport = process.env.PORT || 80;
const server = http.createServer(async (req, res) => {
    try {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        // Serve images if the request is for an image
        if (pathname.startsWith('/images/')) {
            const imagePath = path.join(__dirname, pathname);
            try {
                const imageBuffer = fs.readFileSync(imagePath);
                const mimeType = detectMimeType(imageBuffer);
                res.setHeader('Content-Type', mimeType);
                res.end(imageBuffer);
            } catch (error) {
                res.statusCode = 404;
                res.end('Image not found');
            }
            return;
        }

        const queryObject = parsedUrl.query;
        const telegram_channel = queryObject.channel || 'lookonchainchannel';
        const serverUrl = `http://ftp.raplim-home.ir`;

        try {
            // Check if we have cached data
            const cachedData = rssCache.get(telegram_channel);
            
            if (cachedData) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/xml');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end(cachedData.xml);
            } else {
                // If no cached data, process the feed and start timer
                const xml = await processRssFeed(telegram_channel, serverUrl);
                startChannelTimer(telegram_channel, serverUrl);
                
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/xml');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.end(xml);
            }
        } catch (error) {
            console.error("Error processing RSS:", error);
            res.statusCode = 500;
            res.end("Error generating RSS feed.");
        }
    } catch (error) {
        console.error("Unhandled server error:", error);
        res.statusCode = 500;
        res.end("Internal server error");
    }
});

// Handle server errors
server.on('error', (error) => {
    console.error("Server error:", error);
    // Try to restart server after a delay if it crashes
    setTimeout(() => {
        try {
            server.close();
            server.listen(serverport, () => {
                console.log(`Server restarted and running at port ${serverport}`);
            });
        } catch (e) {
            console.error("Failed to restart server:", e);
        }
    }, 5000);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    // Log error but don't exit process
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled promise rejection:', reason);
    // Log error but don't exit process
});

server.listen(serverport, () => {
    console.log(`Server running at port ${serverport}`);
});