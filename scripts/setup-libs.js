

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const libs = [
    // Tailwind (Standalone for development/prototyping without build step)
    { url: 'https://cdn.tailwindcss.com', dest: 'src/lib/tailwindcss.js' },
    
    // FontAwesome CSS
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css', dest: 'src/lib/fontawesome/css/all.min.css' },
    
    // FontAwesome Webfonts (Crucial for icons to work offline)
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2', dest: 'src/lib/fontawesome/webfonts/fa-solid-900.woff2' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.woff2', dest: 'src/lib/fontawesome/webfonts/fa-regular-400.woff2' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-brands-400.woff2', dest: 'src/lib/fontawesome/webfonts/fa-brands-400.woff2' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.ttf', dest: 'src/lib/fontawesome/webfonts/fa-solid-900.ttf' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.ttf', dest: 'src/lib/fontawesome/webfonts/fa-regular-400.ttf' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-brands-400.ttf', dest: 'src/lib/fontawesome/webfonts/fa-brands-400.ttf' },

    // JS Libraries
    { url: 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js', dest: 'src/lib/html5-qrcode.min.js' },
    { url: 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js', dest: 'src/lib/JsBarcode.all.min.js' },
    { url: 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js', dest: 'src/lib/qrcode.min.js' },
    { url: 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.js', dest: 'src/lib/chart.umd.js' },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', dest: 'src/lib/html2canvas.min.js' },

    // Firebase (Compat versions for simple script usage)
    { url: 'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js', dest: 'src/lib/firebase/firebase-app-compat.js' },
    { url: 'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js', dest: 'src/lib/firebase/firebase-auth-compat.js' },
    { url: 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js', dest: 'src/lib/firebase/firebase-firestore-compat.js' },

    // Logo Image
    { url: 'https://raw.githubusercontent.com/herutama7782/iconomsetpos/refs/heads/main/logo.png', dest: 'src/lib/logo.png' }
];

const download = (url, dest) => {
    const fullPath = path.join(rootDir, dest);
    const dir = path.dirname(fullPath);

    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const file = fs.createWriteStream(fullPath);

    console.log(`Downloading: ${url} ...`);

    const request = https.get(url, (response) => {
        // Handle redirects if any
        if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = new URL(response.headers.location, url).href;
            download(redirectUrl, dest);
            return;
        }

        if (response.statusCode !== 200) {
            console.error(`[ERROR] Failed to download ${url}: Status Code ${response.statusCode}`);
            fs.unlink(fullPath, () => {}); // Delete empty file
            return;
        }

        response.pipe(file);

        file.on('finish', () => {
            file.close();
            console.log(`[OK] Saved to: ${dest}`);
        });
    });

    request.on('error', (err) => {
        fs.unlink(fullPath, () => {});
        console.error(`[ERROR] Downloading ${url}: ${err.message}`);
    });
};

console.log('--- Memulai Unduhan Library Lokal ---');
libs.forEach(lib => download(lib.url, lib.dest));
