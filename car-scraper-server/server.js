// server.js

require('dotenv').config(); // Load environment variables

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const puppeteer = require('puppeteer');
const rateLimit = require('express-rate-limit');
const { createObjectCsvWriter } = require('csv-writer'); // Using 'csv-writer'

const { promisify } = require('util');
const sleep = promisify(setTimeout);

const app = express(); // Initialize Express app

// Environment Variables
const PORT = process.env.PORT || 4000;
const API_KEY = process.env.API_KEY;

// Middleware

// CORS Configuration: Allow only your Chrome extension to access the server
app.use(cors({
  origin: 'chrome-extension://hcbbpjnoeokbejadnhibgigolaibiemb', // Replace with your actual extension ID
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));

app.use(bodyParser.json());

// Rate Limiter for /scrape Endpoint
const scrapeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // limit each IP to 5 requests per windowMs
  message: 'Too many scraping requests from this IP, please try again after a minute.'
});

// API Key Verification Middleware
app.use((req, res, next) => {
  // Allow unrestricted access to the root and download endpoints
  if (req.path === '/' || req.path.startsWith('/download')) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    return res.status(403).json({ error: 'Forbidden: Invalid API Key.' });
  }
  next();
});

// Helper function to normalize domain
function normalizeDomain(domain) {
  return domain.replace(/^www\./, '');
}

// Storage Directory
const STORAGE_DIR = path.join(__dirname, 'storage');
fs.ensureDirSync(STORAGE_DIR);

// POST /addConfig Endpoint
app.post('/addConfig', (req, res) => {
  const { domain, templates } = req.body;
  if (!domain || !templates) {
    return res.status(400).json({ error: 'Domain and templates are required.' });
  }
  const normalizedDomain = normalizeDomain(domain);
  const configPath = path.join(STORAGE_DIR, 'configs.json');
  let configs = {};
  if (fs.existsSync(configPath)) {
    configs = fs.readJSONSync(configPath);
  }
  configs[normalizedDomain] = { templates };
  fs.writeJSONSync(configPath, configs, { spaces: 2 });
  res.json({ message: `Configuration for ${normalizedDomain} saved.` });
});

// POST /getConfig Endpoint
app.post('/getConfig', (req, res) => {
  const { domain } = req.body;
  if (!domain) {
    return res.status(400).json({ error: 'Domain is required.' });
  }
  const normalizedDomain = normalizeDomain(domain);
  const configPath = path.join(STORAGE_DIR, 'configs.json');
  if (!fs.existsSync(configPath)) {
    return res.status(404).json({ error: 'No configurations found.' });
  }
  const configs = fs.readJSONSync(configPath);
  if (configs[normalizedDomain] && configs[normalizedDomain].templates) {
    res.json({ templates: configs[normalizedDomain].templates });
  } else {
    res.status(404).json({ error: 'Configuration not found for the specified domain.' });
  }
});

// ✅ **Newly Added: GET /getDomains Endpoint**
app.get('/getDomains', (req, res) => {
  const configPath = path.join(STORAGE_DIR, 'configs.json');
  if (!fs.existsSync(configPath)) {
    return res.status(404).json({ error: 'No configurations found.' });
  }
  const configs = fs.readJSONSync(configPath);
  const domains = Object.keys(configs);
  res.json({ domains });
});

// Initialize Puppeteer Browser Instance
let browser;
(async () => {
  try {
    browser = await puppeteer.launch({ headless: true });
    console.log('Puppeteer launched successfully.');
  } catch (error) {
    console.error('Failed to launch Puppeteer:', error);
  }
})();

// POST /scrape Endpoint with Rate Limiting
app.post('/scrape', scrapeLimiter, async (req, res) => {
  const { url, templates } = req.body;
  if (!url || !templates) {
    return res.status(400).json({ error: 'URL and templates are required.' });
  }

  const domain = normalizeDomain(new URL(url).hostname);
  const domainDir = path.join(STORAGE_DIR, domain);
  fs.ensureDirSync(domainDir);

  try {
    const page = await browser.newPage();

    // Randomize User-Agent
    const userAgentList = [
      // Add User-Agent strings
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.171 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
      // ... [Add more User-Agent strings as needed]
    ];
    const randomUserAgent = userAgentList[Math.floor(Math.random() * userAgentList.length)];
    await page.setUserAgent(randomUserAgent);

    // Optimize memory usage by blocking unnecessary resources
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    for (let templateName in templates) {
      const template = templates[templateName];
      let currentPageUrl = url;
      let currentPage = 1;
      let hasNextPage = true;
      let aggregatedData = [];

      const paginationLimit = template.paginationLimit || null; // Get pagination limit

      while (hasNextPage) {
        console.log(`Scraping ${templateName} page ${currentPage}: ${currentPageUrl}`);

        await page.goto(currentPageUrl, { waitUntil: 'networkidle2' });

        // Introduce a random delay between 2 to 5 seconds
        await sleep(getRandomDelay());

        // Scrape data based on template
        const scrapedData = await page.evaluate((template) => {
          const extractText = (element, selector, method) => {
            try {
              let el;
              if (method === 'css') {
                el = element.querySelector(selector);
              } else if (method === 'class') {
                el = element.getElementsByClassName(selector.replace('.', ''))[0];
              } else if (method === 'id') {
                el = element.querySelector(`#${selector.replace('#', '')}`);
              } else if (method === 'regex') {
                const regex = new RegExp(selector, 'i');
                el = Array.from(element.querySelectorAll('*')).find(el => regex.test(el.textContent.trim()));
              }
              return el ? el.textContent.trim() : '';
            } catch (error) {
              console.error(`Error extracting text with selector "${selector}" and method "${method}":`, error);
              return '';
            }
          };

          const extractAttribute = (element, selector, attribute, method) => {
            try {
              let el;
              if (method === 'css') {
                el = element.querySelector(selector);
              } else if (method === 'class') {
                el = element.getElementsByClassName(selector.replace('.', ''))[0];
              } else if (method === 'id') {
                el = element.querySelector(`#${selector.replace('#', '')}`);
              } else if (method === 'regex') {
                const regex = new RegExp(selector, 'i');
                el = Array.from(element.querySelectorAll('*')).find(el => regex.test(el.textContent.trim()));
              }
              return el ? el.getAttribute(attribute) : '';
            } catch (error) {
              console.error(`Error extracting attribute "${attribute}" with selector "${selector}" and method "${method}":`, error);
              return '';
            }
          };

          let data = [];
          let items = [];
          const itemMethod = template.itemSelectorMethod || 'css';

          if (itemMethod === 'css') {
            items = document.querySelectorAll(template.itemSelector);
          } else if (itemMethod === 'class') {
            items = document.getElementsByClassName(template.itemSelector.replace('.', ''));
          } else if (itemMethod === 'id') {
            const el = document.querySelector(`#${template.itemSelector.replace('#', '')}`);
            if (el) items = [el];
          } else if (itemMethod === 'regex') {
            const regex = new RegExp(template.itemSelector, 'i');
            items = Array.from(document.querySelectorAll('*')).filter(el => regex.test(el.textContent.trim()));
          }

          if (items.length === 0) {
            console.warn(`No items found with selector "${template.itemSelector}" using method "${itemMethod}"`);
          }

          items.forEach(item => {
            let itemData = {};
            for (let field in template.fields) {
              const fieldInfo = template.fields[field];
              let value = '';
              if (fieldInfo.type === 'text') {
                value = extractText(item, fieldInfo.selector, fieldInfo.method || 'css');
              } else if (fieldInfo.type === 'attribute') {
                value = extractAttribute(item, fieldInfo.selector, fieldInfo.attribute, fieldInfo.method || 'css');
              }
              itemData[field] = value;
            }
            data.push(itemData);
          });

          return data;
        }, template);

        console.log(`Scraped ${scrapedData.length} items from page ${currentPage}`);

        // Aggregate scraped data
        aggregatedData = aggregatedData.concat(scrapedData);

        // Check pagination limit
        if (paginationLimit && currentPage >= paginationLimit) {
          hasNextPage = false;
          console.log(`Pagination limit of ${paginationLimit} pages reached.`);
          break;
        }

        // Check for the next page
        if (template.nextPage && template.nextPage.selector) {
          const nextPageSelector = template.nextPage.selector;
          const nextPageMethod = template.nextPage.method || 'css';
          let nextPageExists = false;
          let nextPageHref = '';

          if (nextPageMethod === 'css') {
            nextPageExists = await page.$(nextPageSelector) !== null;
            if (nextPageExists) {
              nextPageHref = await page.$eval(nextPageSelector, el => el.getAttribute('href'));
            }
          } else if (nextPageMethod === 'class') {
            nextPageExists = await page.$(`.${nextPageSelector.replace('.', '')}`) !== null;
            if (nextPageExists) {
              nextPageHref = await page.$eval(`.${nextPageSelector.replace('.', '')}`, el => el.getAttribute('href'));
            }
          } else if (nextPageMethod === 'id') {
            nextPageExists = await page.$(`#${nextPageSelector.replace('#', '')}`) !== null;
            if (nextPageExists) {
              nextPageHref = await page.$eval(`#${nextPageSelector.replace('#', '')}`, el => el.getAttribute('href'));
            }
          } else if (nextPageMethod === 'regex') {
            const links = await page.$$eval('a', anchors => anchors.map(a => ({ href: a.href, text: a.textContent.trim() })));
            const regex = new RegExp(nextPageSelector, 'i');
            const nextLink = links.find(link => regex.test(link.text));
            if (nextLink) {
              nextPageExists = true;
              nextPageHref = nextLink.href;
            }
          }

          if (nextPageExists && nextPageHref) {
            // Construct absolute URL if necessary
            currentPageUrl = new URL(nextPageHref, currentPageUrl).href;
            currentPage++;
          } else {
            hasNextPage = false;
          }
        } else {
          hasNextPage = false;
        }
      }

      // Save data to CSV
      if (aggregatedData.length > 0) {
        const templateDir = path.join(domainDir, templateName);
        fs.ensureDirSync(templateDir);

        const headers = Object.keys(aggregatedData[0]).map(key => ({ id: key, title: key }));

        const csvWriter = createObjectCsvWriter({
          path: path.join(templateDir, `data_${Date.now()}.csv`),
          header: headers,
        });

        await csvWriter.writeRecords(aggregatedData);
        console.log(`Data saved to CSV file for template "${templateName}".`);
      } else {
        console.warn(`No data collected for template "${templateName}". CSV file will not be created.`);
      }
    }

    await page.close();

    res.json({ message: 'Scraping completed successfully.' });
  } catch (error) {
    console.error('Scraping Error:', error);
    res.status(500).json({ error: 'Scraping failed.' });
  }
});

function getRandomDelay() {
  return Math.floor(Math.random() * (5000 - 2000 + 1)) + 2000;
}

// GET /files Endpoint
app.get('/files', (req, res) => {
  try {
    const domains = fs.readdirSync(STORAGE_DIR).filter(dir => dir !== 'configs.json');
    let filesList = {};

    domains.forEach(domain => {
      const domainPath = path.join(STORAGE_DIR, domain);
      const entries = fs.readdirSync(domainPath);

      filesList[domain] = {};

      entries.forEach(entry => {
        const entryPath = path.join(domainPath, entry);
        const stats = fs.statSync(entryPath);

        if (stats.isDirectory()) {
          // Entry is a template directory
          const template = entry;
          const templatePath = entryPath;
          const files = fs.readdirSync(templatePath).filter(file => file.endsWith('.csv'));
          filesList[domain][template] = files;
        } else if (stats.isFile() && entry.endsWith('.csv')) {
          // Entry is a CSV file directly under the domain
          const template = '_no_template_';
          if (!filesList[domain][template]) {
            filesList[domain][template] = [];
          }
          filesList[domain][template].push(entry);
        }
      });
    });

    res.json(filesList);
  } catch (error) {
    console.error('Files Retrieval Error:', error);
    res.status(500).json({ error: 'Failed to retrieve files.' });
  }
});

// GET /download Endpoint
app.get('/download', (req, res) => {
  const { domain, template, file } = req.query;

  if (!domain || !file) {
    return res.status(400).send('Domain and file parameters are required.');
  }

  const normalizedDomain = normalizeDomain(domain);
  let filePath;

  if (template && template !== '_no_template_') {
    // File is under a template directory
    filePath = path.join(STORAGE_DIR, normalizedDomain, template, file);
  } else {
    // File is directly under the domain directory
    filePath = path.join(STORAGE_DIR, normalizedDomain, file);
  }

  if (fs.existsSync(filePath)) {
    res.download(filePath);
  } else {
    res.status(404).send('File not found.');
  }
});

// Root Endpoint (Optional: For testing server status)
app.get('/', (req, res) => {
  res.send(`Server is running on http://localhost:${PORT}`);
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
