const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

// Base URL of the target website
const BASE_URL = "https://autogidas.lt/skelbimai/automobiliai/";
// Headers to make the request look like it's coming from a regular browser
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
};

// Function to get the HTML content of a page
const getPageContent = async (url) => {
    try {
        console.log(`Fetching page content from: ${url}`);
        // Send GET request to the URL with headers
        const response = await axios.get(url, { headers: HEADERS });
        console.log(`Successfully retrieved page content from: ${url}`);
        return response.data;
    } catch (error) {
        // Log error if the request fails
        console.error(`Failed to retrieve page content from: ${url}. Error: ${error.message}`);
        return null;
    }
};

// Function to scrape car data from the page content
const scrapeCarData = (pageContent) => {
    console.log('Scraping car data from page content...');
    // Load the HTML content into cheerio for parsing
    const $ = cheerio.load(pageContent);
    // Select all elements with class 'article-item' which represent car listings
    const carListings = $('.article-item');
    const scrapedData = [];

    // Iterate over each car listing to extract data
    carListings.each((_, element) => {
        // Extract the URL of the detailed listing
        const detailPageUrl = BASE_URL.slice(0, -11) + $(element).find('a.item-link').attr('href');
        const title = $(element).find('.item-title').text().trim();
        const price = $(element).find('.item-price').text().trim();
        const imageUrl = $(element).find('.image img').attr('data-src') || $(element).find('.image img').attr('src');

        // Extract additional specifications from the listing
        const specifications = {
            Year: '',
            Fuel: '',
            Gearbox: '',
            Engine: '',
            Mileage: '',
            Location: ''
        };

        $(element).find('.params .icon').each((_, spec) => {
            const key = $(spec).find('i').text().trim();
            const value = $(spec).find('b').text().trim();
            if (key && value) {
                if (key === 'Metai') specifications.Year = value;
                else if (key === 'Kuro tipas') specifications.Fuel = value;
                else if (key === 'Pavarų dėžė') specifications.Gearbox = value;
                else if (key === 'Variklis') specifications.Engine = value;
                else if (key === 'Rida') specifications.Mileage = value;
                else if (key === 'Miestas') specifications.Location = value;
            }
        });

        // Only add to the scraped data if price and title are available
        if (price && title) {
            scrapedData.push({
                Title: title,
                Price: price,
                ImageURL: imageUrl,
                Year: specifications.Year,
                Fuel: specifications.Fuel,
                Gearbox: specifications.Gearbox,
                Engine: specifications.Engine,
                Mileage: specifications.Mileage,
                Location: specifications.Location,
                DetailPageURL: detailPageUrl
            });
        }
    });

    console.log(`Scraped ${scrapedData.length} car listings from the page.`);
    return scrapedData;
};

// Function to save scraped data to a CSV file
const saveToCSV = (data, filename = 'autogidas_data.csv') => {
    if (!data.length) {
        console.log("No data available to save.");
        return;
    }

    console.log(`Saving scraped data to ${filename}...`);
    // Extract keys from the first data object to use as CSV headers
    const keys = Object.keys(data[0]);
    // Create CSV content by joining the headers and each row of data
    const csvContent = [keys.join(","), ...data.map(item => keys.map(key => item[key].replace(/,/g, '')).join(","))].join("\n");

    // Write the CSV content to a file
    fs.writeFileSync(filename, csvContent, 'utf8');
    console.log(`Scraped data saved to ${filename}`);
};

// Main function to orchestrate the scraping process
const main = async () => {
    let scrapedData = [];
    // Loop through the first 5 pages of car listings
    for (let pageNumber = 1; pageNumber <= 5; pageNumber++) {
        const url = `${BASE_URL}?page=${pageNumber}`;
        console.log(`Processing page ${pageNumber}...`);
        // Get the content of the current page
        const pageContent = await getPageContent(url);
        if (pageContent) {
            // Scrape car data from the page content
            const data = scrapeCarData(pageContent);
            // Concatenate the newly scraped data with the existing data
            scrapedData = scrapedData.concat(data);
        }
        // Add a delay of 2 seconds to avoid being blocked by the server
        console.log('Waiting for 2 seconds before fetching the next page...');
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Save the scraped data to a CSV file
    saveToCSV(scrapedData);
};

// Run the main function
main();