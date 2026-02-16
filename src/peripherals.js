
import { getSettingFromDB, getAllFromDB, getFromDB } from "./db.js";

// Helper for UI functions that might be used before window.app is fully ready 
// (Using window globals to break circular dependencies with ui.js)
const showToast = (msg) => window.showToast ? window.showToast(msg) : console.log(msg);
const formatCurrency = (val) => window.formatCurrency ? window.formatCurrency(val) : val;
const formatReceiptDate = (val) => window.formatReceiptDate ? window.formatReceiptDate(val) : val;
const showConfirmationModal = (...args) => window.showConfirmationModal ? window.showConfirmationModal(...args) : confirm(args[1]);

// Tuning umum
const LINE_SPACING_DOTS = 30; // 24=single, 30=~1.25
const FEED_AFTER_IMAGE = 0;   // feed setelah logo
const FEED_BEFORE_CUT = 2;    // feed sebelum cut

// --- LOGO LINE-ART SETTINGS ---
// Mode: 'solid' = vektor flat hitam-putih (tanpa gradasi, background putih)
//       'outline' = hanya garis tepi (tanpa isi)
const LOGO_LINE_ART_MODE = 'solid';    // 'solid' | 'outline'
const LOGO_MAX_HEIGHT = 180;           // tinggi maks logo (dots)
const LOGO_THRESHOLD = 'auto';         // 'auto' (Otsu) atau angka 0–255
const LOGO_ENSURE_WHITE_BG = true;     // paksa background putih (auto-invert jika perlu)
const LOGO_DESPECKLE = true;           // bersihkan noise titik kecil
const LOGO_OUTLINE_THICKNESS = 1;      // ketebalan outline jika mode 'outline'

// Variable untuk mencegah double scan
let isScanProcessing = false;
let lastScanTimestamp = 0; // Timestamp scan terakhir
const SCAN_COOLDOWN = 2000; // Jeda waktu (ms) sebelum boleh scan lagi

// --- TEXT UTILS ---
function justifyLine(text, width) {
  const t = (text || '').trim();
  if (!t) return ''.padEnd(width, ' ');
  if (t.length >= width) return t.slice(0, width);

  const words = t.split(/\s+/);
  if (words.length === 1) return t.padEnd(width, ' ');

  const wordsLen = words.reduce((a, w) => a + w.length, 0);
  const spacesNeeded = width - wordsLen;
  const gaps = words.length - 1;
  const base = Math.floor(spacesNeeded / gaps);
  let extra = spacesNeeded % gaps;

  let out = '';
  for (let i = 0; i < words.length; i++) {
    out += words[i];
    if (i < gaps) {
      const add = base + (extra > 0 ? 1 : 0);
      out += ' '.repeat(add);
      if (extra > 0) extra--;
    }
  }
  return out;
}

function centerPad(text, width) {
  const t = (text || '').trim();
  if (!t) return ' '.repeat(width);
  if (t.length >= width) return t.slice(0, width);
  const left = Math.floor((width - t.length) / 2);
  const right = width - t.length - left;
  return ' '.repeat(left) + t + ' '.repeat(right);
}

function wrapWords(text, width) {
  const raw = (text || '').toString().replace(/\s+/g, ' ').trim();
  if (!raw) return [' '.repeat(width)];
  const words = raw.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line.length) {
      line = w;
    } else if ((line.length + 1 + w.length) <= width) {
      line += ' ' + w;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.map(l => l || ' '.repeat(width));
}

function wrapAndCenter(text, width) {
  return wrapWords(text, width).map(l => centerPad(l, width));
}

// --- IMAGE UTILS ---
// Crop putih atas-bawah di kanvas logo (mengurangi gap vertikal)
function cropCanvasTopBottom(canvas, whiteThreshold = 245) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;

  const isRowWhite = (y) => {
    let offset = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = offset + x * 4;
      const a = data[i + 3];
      if (a > 5) {
        const gray = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (gray < whiteThreshold) return false;
      }
    }
    return true;
  };

  let top = 0;
  while (top < height && isRowWhite(top)) top++;
  let bottom = height - 1;
  while (bottom > top && isRowWhite(bottom)) bottom--;

  const cropH = Math.max(1, bottom - top + 1);
  if (cropH === height && top === 0) return canvas;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = cropH;
  const octx = out.getContext('2d');
  octx.drawImage(canvas, 0, top, width, cropH, 0, 0, width, cropH);
  return out;
}

// Otsu threshold (auto)
function otsuThresholdFromImageData(imgData) {
  const hist = new Array(256).fill(0);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]) | 0;
    hist[g]++;
  }
  const total = imgData.width * imgData.height;
  let sum = 0; for (let t=0; t<256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, varMax = -1, thr = 180;
  for (let t=0; t<256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > varMax) { varMax = between; thr = t; }
  }
  if (thr < 150) thr = 150;
  if (thr > 230) thr = 230;
  return thr;
}

// Binarize -> Uint8Array mask 0/1 (1=hitam)
function toMonoMask(imgData, threshold) {
  const d = imgData.data;
  const W = imgData.width, H = imgData.height;
  const mask = new Uint8Array(W * H);
  let black = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const gray = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
    const m = gray < threshold ? 1 : 0; // 1=hitam
    mask[p] = m;
    if (m) black++;
  }
  mask._blackRatio = black / (W * H);
  return mask;
}

// Bersihkan noise titik hitam tunggal
function despeckleMask(mask, W, H) {
  const out = mask.slice();
  for (let y=1; y<H-1; y++) {
    for (let x=1; x<W-1; x++) {
      const i = y*W + x;
      if (!mask[i]) continue;
      let n = 0;
      n += mask[i-1] + mask[i+1] + mask[i-W] + mask[i+W];
      n += mask[i-W-1] + mask[i-W+1] + mask[i+W-1] + mask[i+W+1];
      if (n <= 1) out[i] = 0;
    }
  }
  return out;
}

// Outline-only dari mask (boundary = mask - erode(mask))
function outlineFromMask(mask, W, H, thickness=1) {
  const er = new Uint8Array(W*H);
  for (let y=1; y<H-1; y++) {
    for (let x=1; x<W-1; x++) {
      const i = y*W + x;
      if (!mask[i]) continue;
      let all = 1;
      for (let dy=-1; dy<=1 && all; dy++) {
        for (let dx=-1; dx<=1; dx++) {
          if (!mask[i + dy*W + dx]) { all = 0; break; }
        }
      }
      er[i] = all ? 1 : 0;
    }
  }
  const edge = new Uint8Array(W*H);
  for (let i=0; i<edge.length; i++) edge[i] = mask[i] && !er[i] ? 1 : 0;

  if (thickness > 1) {
    const dil = edge.slice();
    for (let y=1; y<H-1; y++) for (let x=1; x<W-1; x++) {
      const i = y*W + x;
      if (!edge[i]) continue;
      for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++) {
        dil[i + dy*W + dx] = 1;
      }
    }
    return dil;
  }
  return edge;
}

// Pastikan background putih (kalau rasio hitam terlalu besar, invert)
function ensureWhiteBackground(mask, W, H) {
  const sum = mask.reduce((a,b)=>a+b,0);
  const ratio = sum / (W*H);
  if (ratio > 0.5) {
    for (let i=0;i<mask.length;i++) mask[i] = mask[i] ? 0 : 1;
  }
  return mask;
}

// Pack mask 0/1 ke raster ESC/POS (GS v 0)
function buildRasterGSv0(mask, W, H) {
  const rowBytes = Math.ceil(W / 8);
  const payload = new Uint8Array(rowBytes * H);
  for (let y=0; y<H; y++) {
    for (let x=0; x<W; x++) {
      const bit = mask[y*W + x] ? 1 : 0; // 1=hitam
      const byteIndex = y*rowBytes + (x >> 3);
      const bitIndex = 7 - (x & 7);
      if (bit) payload[byteIndex] |= (1 << bitIndex);
    }
  }
  const xL = rowBytes & 0xFF, xH = (rowBytes >> 8) & 0xFF;
  const yL = H & 0xFF, yH = (H >> 8) & 0xFF;
  const header = new Uint8Array([0x1D, 0x76, 0x30, 0x00, xL, xH, yL, yH]);
  return { header, payload };
}

// --- CAMERA FUNCTIONS ---
export async function openCameraModal() {
    const modal = document.getElementById('cameraModal');
    const video = document.getElementById('cameraFeed');
    const photoPreview = document.getElementById('photoPreview');
    const errorEl = document.getElementById('cameraError');
    const captureBtn = document.getElementById('captureBtn');
    const retakeBtn = document.getElementById('retakeBtn');
    const usePhotoBtn = document.getElementById('usePhotoBtn');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        errorEl.textContent = 'Kamera tidak didukung oleh browser ini.';
        errorEl.style.display = 'block';
        video.style.display = 'none';
        captureBtn.style.display = 'none';
        modal.classList.remove('hidden');
        return;
    }
    
    // Reset UI
    errorEl.style.display = 'none';
    video.style.display = 'block';
    photoPreview.style.display = 'none';
    captureBtn.style.display = 'flex';
    retakeBtn.style.display = 'none';
    usePhotoBtn.style.display = 'none';

    modal.classList.remove('hidden');

    try {
        const constraints = { video: { facingMode: "environment" } };
        window.app.cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = window.app.cameraStream;
        await video.play();
    } catch (err) {
        console.error("Error accessing camera:", err);
        errorEl.textContent = 'Gagal mengakses kamera. Pastikan izin telah diberikan.';
        errorEl.style.display = 'block';
        video.style.display = 'none';
        captureBtn.style.display = 'none';
    }
}

export function closeCameraModal() {
    if (window.app.cameraStream) {
        window.app.cameraStream.getTracks().forEach(track => track.stop());
        window.app.cameraStream = null;
    }
    const video = document.getElementById('cameraFeed');
    if (video) video.srcObject = null;
    document.getElementById('cameraModal').classList.add('hidden');
}

export function capturePhoto() {
    const video = document.getElementById('cameraFeed');
    const canvas = document.getElementById('cameraCanvas');
    const photoPreview = document.getElementById('photoPreview');
    const captureBtn = document.getElementById('captureBtn');
    const retakeBtn = document.getElementById('retakeBtn');
    const usePhotoBtn = document.getElementById('usePhotoBtn');
    const context = canvas.getContext('2d');

    // Scale down if necessary
    let width = video.videoWidth;
    let height = video.videoHeight;
    const MAX_SIZE = 500;

    if (width > height) {
        if (width > MAX_SIZE) {
            height *= MAX_SIZE / width;
            width = MAX_SIZE;
        }
    } else {
        if (height > MAX_SIZE) {
            width *= MAX_SIZE / height;
            height = MAX_SIZE;
        }
    }

    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    
    // Save as JPEG with compression
    photoPreview.src = canvas.toDataURL('image/jpeg', 0.7);
    photoPreview.style.display = 'block';
    video.style.display = 'none';

    captureBtn.style.display = 'none';
    retakeBtn.style.display = 'block';
    usePhotoBtn.style.display = 'block';
}

export function retakePhoto() {
    const video = document.getElementById('cameraFeed');
    const photoPreview = document.getElementById('photoPreview');
    const captureBtn = document.getElementById('captureBtn');
    const retakeBtn = document.getElementById('retakeBtn');
    const usePhotoBtn = document.getElementById('usePhotoBtn');

    photoPreview.style.display = 'none';
    video.style.display = 'block';

    captureBtn.style.display = 'flex';
    retakeBtn.style.display = 'none';
    usePhotoBtn.style.display = 'none';
}

export function useCapturedPhoto() {
    const canvas = document.getElementById('cameraCanvas');
    const activeModal = document.getElementById('addProductModal').classList.contains('hidden') ? 'edit' : 'add';
    
    // The canvas already holds the resized image from capturePhoto, just get data URL
    const imageData = canvas.toDataURL('image/jpeg', 0.7);

    if (activeModal === 'add') {
        window.app.currentImageData = imageData;
        document.getElementById('imagePreview').innerHTML = `<img src="${window.app.currentImageData}" alt="Preview" class="image-preview">`;
    } else {
        window.app.currentEditImageData = imageData;
        document.getElementById('editImagePreview').innerHTML = `<img src="${window.app.currentEditImageData}" alt="Preview" class="image-preview">`;
    }
    
    closeCameraModal();
}

// --- BARCODE SCANNING ---
function startScanner() {
    if (!window.app?.isScannerReady || typeof Html5Qrcode === 'undefined') {
        console.warn('Scanner library not ready.');
        showToast('Pemindai belum siap. Muat ulang halaman atau periksa koneksi.');
        return;
    }
    
    if (window.app.html5QrCode.isScanning) {
        // Prevent starting if already scanning
        return;
    }

    // Reset processing state
    isScanProcessing = false;
    // Reset timestamp to allow immediate scan (or set to now to force initial delay)
    lastScanTimestamp = 0; 
    
    const onScanSuccess = async (decodedText, decodedResult) => {
        const now = Date.now();

        // 1. Time Debounce Check (Mencegah double scan dalam waktu singkat)
        if (now - lastScanTimestamp < SCAN_COOLDOWN) {
            return;
        }

        // 2. Logic Lock Check (Mencegah proses tumpang tindih)
        if (isScanProcessing) return;
        
        // Lock processing and update timestamp
        isScanProcessing = true;
        lastScanTimestamp = now;

        if (window.app.scanCallback) {
            window.app.scanCallback(decodedText);
            // closeScanModal will handle stopping, keep lock true to prevent rapid re-fire
            return;
        }

        const products = await getAllFromDB('products');
        const product = products.find(p => p.barcode === decodedText);

        if (product) {
            // Using window.addToCart to avoid circular dependency
            if (typeof window.addToCart === 'function') {
                window.addToCart(product.id);
            } else if (window.app && window.app.addToCart) {
                // Alternative access via global app state
                window.app.addToCart(product.id);
            } else {
                 console.error("addToCart function not found globally.");
            }
            
            closeScanModal(); // This will stop the scanner and hide modal
        } else {
            // Stop scanning temporarily to show error toast
            if (window.app.html5QrCode.isScanning) {
                try {
                    await window.app.html5QrCode.stop();
                } catch (e) { console.warn('Pause scan error', e); }
            }
            
            showToast(`Produk dengan barcode ${decodedText} tidak ditemukan.`);
            
            setTimeout(() => {
                if (document.getElementById('scanModal').classList.contains('hidden') === false) {
                     // Check if not scanning before restarting
                     if (!window.app.html5QrCode.isScanning) {
                        // Release lock to allow scanning again
                        isScanProcessing = false;
                        // Restart with FPS 5
                        window.app.html5QrCode.start({ facingMode: "environment" }, { fps: 5, qrbox: { width: 250, height: 250 } }, onScanSuccess, (errorMessage) => {}).catch((e)=>console.warn('Re-start scanner failed', e));
                     }
                } else {
                    // Modal closed by user during delay, just reset lock
                    isScanProcessing = false;
                }
            }, 2000);
        }
    };
    
    const onScanFailure = (error) => {};
    
    // FPS reduced to 5 to reduce CPU load and double-scan probability
    window.app.html5QrCode.start({ facingMode: "environment" }, { fps: 5, qrbox: { width: 250, height: 250 } }, onScanSuccess, onScanFailure)
      .catch((err) => {
        showToast('Gagal memulai kamera. Pastikan izin telah diberikan.');
        console.error("Failed to start QR code reader:", err);
      });
}

export function showScanModal() {
    if (!window.app?.isScannerReady || typeof Html5Qrcode === 'undefined') {
        showToast('Pemindai barcode gagal dimuat.');
        return;
    }
    (document.getElementById('scanModal')).classList.remove('hidden');
    startScanner();
}

export async function scanBarcodeForInput(targetInputId) {
    const useExternal = await getSettingFromDB('useExternalScanner');
    if (useExternal) {
        const inputEl = document.getElementById(targetInputId);
        if (inputEl) {
            inputEl.focus();
            showToast('Siap memindai (Gunakan scanner USB/BT)...', 2000);
        }
        return;
    }

    window.app.scanCallback = (decodedText) => {
        const inputEl = document.getElementById(targetInputId);
        if (inputEl) {
            inputEl.value = decodedText;
            // Dispatch input event to trigger listeners (e.g. search function)
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        closeScanModal();
    };
    showScanModal();
};

export async function handleKasirScan() {
    const useExternal = await getSettingFromDB('useExternalScanner');
    if (useExternal) {
        const inputEl = document.getElementById('searchProduct');
        if (inputEl) {
            inputEl.focus();
            // Select text if any, so user can easily overwrite or append
            // inputEl.select(); 
            showToast('Siap memindai (Gunakan scanner USB/BT)...', 2000);
        }
    } else {
        window.app.scanCallback = null;
        showScanModal();
    }
}

export async function closeScanModal() {
    const modal = document.getElementById('scanModal');
    // Always reset the lock when closing modal to ensure fresh state next time
    isScanProcessing = false;
    // Don't reset lastScanTimestamp here, to prevent immediate re-scan if they re-open instantly

    if (modal && !modal.classList.contains('hidden')) {
        modal.classList.add('hidden');
        if (window.app.html5QrCode) {
            try {
                if (window.app.html5QrCode.isScanning) {
                    await window.app.html5QrCode.stop();
                }
            } catch (err) {
                console.warn("Scanner stop error (safe to ignore):", err);
            }
        }
    }
    window.app.scanCallback = null;
}

// --- RECEIPT PRINTING ---
function sendToRawBT(data) {
    // Tambahkan Line Feed (0x0A) di akhir
    const dataWithLF = new Uint8Array(data.length + 1);
    dataWithLF.set(data, 0);
    dataWithLF[data.length] = 0x0A; // LF

    let binary = '';
    for (let i = 0; i < dataWithLF.byteLength; i++) {
        binary += String.fromCharCode(dataWithLF[i]);
    }
    const base64 = btoa(binary);
    const intentUrl = `rawbt:base64,${base64}`;
    window.location.href = intentUrl;
}

async function _generateReceiptText(transactionData, isPreview) {
  const settings = await getAllFromDB('settings');
  const settingsMap = new Map(settings.map(s => [s.key, s.value]));

  const storeName = settingsMap.get('storeName') || 'Toko Anda';
  const storeAddress = settingsMap.get('storeAddress') || '';
  const feedbackPhone = settingsMap.get('storeFeedbackPhone') || '';
  const footerText = settingsMap.get('storeFooterText') || 'Terima kasih!';
  const couponMinPurchase = settingsMap.get('couponMinPurchase') || 0;
  const couponText = settingsMap.get('couponText') || '';
  const paperSize = settingsMap.get('printerPaperSize') || '80mm';
  const paperWidthChars = paperSize === '58mm' ? 32 : 42;

  const receiptLine = (char) => char.repeat(paperWidthChars);
  const formatLine = (left, right) => {
    const spaces = Math.max(0, paperWidthChars - left.length - right.length);
    return left + ' '.repeat(spaces) + right;
  };

  let receiptText = '';

  // HEADER: center + word-wrap
  wrapAndCenter(storeName, paperWidthChars).forEach(l => receiptText += l + '\n');
  if (storeAddress) {
    storeAddress.split('\n').forEach(row => {
      if (row.trim()) wrapAndCenter(row, paperWidthChars).forEach(l => receiptText += l + '\n');
    });
  }

  receiptText += receiptLine('=') + '\n';
  
  receiptText += `No: ${transactionData.id || (isPreview ? 'PREVIEW' : 'N/A')}\n`;
  receiptText += `Tgl: ${formatReceiptDate(transactionData.date)}\n`;
  if (transactionData.userName && transactionData.userName !== 'N/A') {
    receiptText += `Kasir: ${transactionData.userName}\n`;
  }
  if (transactionData.customerName) {
    receiptText += `Pelanggan: ${transactionData.customerName}\n`;
  }
  receiptText += receiptLine('-') + '\n';

  transactionData.items.forEach(item => {
    receiptText += `${item.name}\n`;
    const totalItemPriceText = `${formatCurrency(item.effectivePrice * item.quantity)}`;
    
    // Use basePrice for detail line, fallback to price for older transactions
    const basePriceForDetail = item.basePrice !== undefined ? item.basePrice : item.price;
    let priceDetailText = `${formatCurrency(basePriceForDetail)}`;

    let discountInfo = item.discount;
    // For old transactions that are re-printed, we need backward compatibility.
    if (!discountInfo && item.discountPercentage > 0) {
        discountInfo = { type: 'percentage', value: item.discountPercentage };
    }
    if (discountInfo && discountInfo.value > 0) {
        if (discountInfo.type === 'percentage') {
            priceDetailText += ` Disc ${discountInfo.value}%`;
        } else { // fixed
            priceDetailText += ` Disc ${formatCurrency(discountInfo.value)}`;
        }
    }

    priceDetailText += ` x${item.quantity}`;

    receiptText += formatLine(priceDetailText, totalItemPriceText) + '\n';

    if (item.isWholesale) {
        receiptText += `Grosir\n`;
    }
  });

  const subtotalAfterDiscount = transactionData.items.reduce((sum, item) => {
    return sum + Math.round(item.effectivePrice * item.quantity);
  }, 0);

  receiptText += receiptLine('-') + '\n';
  receiptText += formatLine('Subtotal', `${formatCurrency(subtotalAfterDiscount)}`) + '\n';

  if (transactionData.fees && transactionData.fees.length > 0) {
    transactionData.fees.forEach(fee => {
      let feeName = fee.name;
      if (fee.type === 'percentage') feeName += ` ${fee.value}%`;
      const feeAmount = `${formatCurrency(fee.amount)}`;
      receiptText += formatLine(feeName, feeAmount) + '\n';
    });
  }

  receiptText += receiptLine('=') + '\n';
  receiptText += formatLine('TOTAL', `${formatCurrency(transactionData.total)}`) + '\n';

  if (transactionData.donation && transactionData.donation > 0) {
      receiptText += formatLine('Donasi', `${formatCurrency(transactionData.donation)}`) + '\n';
  }
  
  const paymentMethodLabel = transactionData.paymentMethod || 'TUNAI';
  
  let displayPaymentLabel = paymentMethodLabel;
  let displayChangeLabel = 'KEMBALI';

  if (paymentMethodLabel === 'PIUTANG') {
      displayPaymentLabel = 'Cash';
      displayChangeLabel = 'Piutang';
  }

  receiptText += formatLine(displayPaymentLabel, `${formatCurrency(transactionData.cashPaid)}`) + '\n';
  receiptText += formatLine(displayChangeLabel, `${formatCurrency(transactionData.change)}`) + '\n';

  receiptText += receiptLine('-') + '\n';
  const totalDiscount = transactionData.totalDiscount || 0;
  if (totalDiscount > 0) {
      receiptText += formatLine('ANDA HEMAT', `${formatCurrency(totalDiscount)}`) + '\n';
  }

  receiptText += receiptLine('=') + '\n';

  // --- POINT SYSTEM ON RECEIPT ---
    if (transactionData.pointsEarned > 0 && transactionData.customerId) {
        try {
            const customer = await getFromDB('contacts', transactionData.customerId);
            if (customer) {
                receiptText += centerPad('POIN REWARD', paperWidthChars) + '\n';
                const formatLineNoRp = (left, right) => {
                    const spaces = Math.max(0, paperWidthChars - left.length - right.length);
                    return left + ' '.repeat(spaces) + right;
                };
                receiptText += formatLineNoRp('Poin Didapat', `+${transactionData.pointsEarned}`) + '\n';
                receiptText += formatLineNoRp('Total Poin Anda', `${customer.points || 0}`) + '\n';
                receiptText += receiptLine('-') + '\n';
            }
        } catch (e) {
            console.error("Could not fetch customer for receipt points:", e);
        }
    }
  // --- END POINT SYSTEM ON RECEIPT ---

  // FOOTER
  if (footerText) {
    wrapAndCenter(footerText, paperWidthChars).forEach(l => receiptText += l + '\n');
  }
  if (feedbackPhone) {
    wrapAndCenter(`Kritik/Saran: ${feedbackPhone}`, paperWidthChars).forEach(l => receiptText += l + '\n');
  }

  // Coupon Text
  if (couponMinPurchase > 0 && couponText && transactionData.total >= couponMinPurchase) {
      receiptText += receiptLine('-') + '\n';
      wrapAndCenter(couponText, paperWidthChars).forEach(l => receiptText += l + '\n');
  }

  return receiptText;
}

async function _generateReceiptHTML(data, isPreview) {
  const settings = await getAllFromDB('settings');
  const settingsMap = new Map(settings.map(s => [s.key, s.value]));
  const logoData = settingsMap.get('storeLogo') || null;
  const showLogo = settingsMap.get('showLogoOnReceipt') !== false;

  const paperSize = settingsMap.get('printerPaperSize') || '80mm';
  const paperWidthChars = paperSize === '58mm' ? 32 : 42;

  let receiptText = await _generateReceiptText(data, isPreview);

  const wrapperStart = `<div style="width:${paperWidthChars}ch; margin:0 auto; font-family: ui-monospace, Menlo, Monaco, Consolas, 'Courier New', monospace; line-height:1.25;">`;
  const wrapperEnd = `</div>`;

  const logoHtml = (showLogo && logoData)
    ? `<div style="width:${paperWidthChars}ch; margin:0 auto; text-align:left; margin-bottom:2px;">
         <img src="${logoData}" alt="Logo" style="display:block; width:100%; max-height:120px; object-fit:contain; background:#fff;">
       </div>`
    : '';

  const pre = document.createElement('pre');
  pre.style.margin = '0';
  pre.style.whiteSpace = 'pre-wrap';
  pre.textContent = receiptText;

  pre.innerHTML = pre.innerHTML.replace(/^(TOTAL\s+.*)$/m, `<b>$1</b>`);

  return wrapperStart + logoHtml + pre.outerHTML + wrapperEnd;
}

async function generateReceiptEscPos(transactionData) {
  if (!window.app.isPrinterReady) throw new Error('Printer library not loaded.');

  const settings = await getAllFromDB('settings');
  const settingsMap = new Map(settings.map(s => [s.key, s.value]));
  const logoData = settingsMap.get('storeLogo') || null;
  const showLogo = settingsMap.get('showLogoOnReceipt') !== false;
  const paperSize = settingsMap.get('printerPaperSize') || '80mm';
  const autoOpenCashDrawer = settingsMap.get('autoOpenCashDrawer') || false;

  // NOTE: jika printer 80mm Anda 512 dots, ganti 576 -> 512
  const paperWidthDots  = paperSize === '58mm' ? 384 : 576;

  const encoder = new EscPosEncoder.default();
  encoder
    .initialize()
    .raw([0x1b, 0x40])   // ESC @ reset
    .raw([0x1b, 0x40])   // reset ekstra
    .align('left')
    .raw([0x1b, 0x33, LINE_SPACING_DOTS]);  // atur line spacing

  // Cetak logo: pure black line-art 1-bit (GS v 0)
  if (showLogo && logoData) {
    try {
      const image = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.crossOrigin = 'anonymous';
        img.src = logoData;
      });

      const ratio = paperWidthDots / image.width;
      const w = paperWidthDots;
      const h = Math.min(Math.round(image.height * ratio), LOGO_MAX_HEIGHT);

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);

      const cropped = cropCanvasTopBottom(canvas, 245);
      const cctx = cropped.getContext('2d', { willReadFrequently: true });
      const src = cctx.getImageData(0, 0, cropped.width, cropped.height);

      const thr = (LOGO_THRESHOLD === 'auto')
        ? otsuThresholdFromImageData(src)
        : (typeof LOGO_THRESHOLD === 'number' ? LOGO_THRESHOLD : 215);

      let mask = toMonoMask(src, thr);
      if (LOGO_DESPECKLE) mask = despeckleMask(mask, cropped.width, cropped.height);

      if (LOGO_LINE_ART_MODE === 'outline') {
        mask = outlineFromMask(mask, cropped.width, cropped.height, LOGO_OUTLINE_THICKNESS);
      }

      if (LOGO_ENSURE_WHITE_BG) {
        mask = ensureWhiteBackground(mask, cropped.width, cropped.height);
      }

      // Build raster dan kirim sebagai raw ESC/POS (GS v 0)
      const { header, payload } = buildRasterGSv0(mask, cropped.width, cropped.height);

      encoder.align('center');
      encoder.raw(Array.from(header));
      encoder.raw(Array.from(payload));
      if (FEED_AFTER_IMAGE > 0) encoder.feed(FEED_AFTER_IMAGE);
      encoder.align('left');
    } catch (e) {
      console.error('Failed to process logo for printing:', e);
    }
  }

  // Cetak teks (semua rata kiri; kolom kanan via spasi)
  const paperWidthChars = paperSize === '58mm' ? 32 : 42;
  const receiptText = await _generateReceiptText(transactionData, false);
  receiptText.split('\n').forEach(line => {
    if (!line) { encoder.line(''); return; }
    const safe = line.length > paperWidthChars ? line.slice(0, paperWidthChars) : line;
    if (safe.startsWith('TOTAL')) {
      encoder.bold(true).line(safe.padEnd(paperWidthChars, ' ')).bold(false);
    } else {
      encoder.line(safe.padEnd(paperWidthChars, ' '));
    }
  });

  if (autoOpenCashDrawer) {
    encoder.pulse();
  }
  encoder.feed(FEED_BEFORE_CUT).cut();
  return encoder.encode();
}

export async function generateReceiptContent(transactionData, targetElementId = 'receiptContent') {
    const contentEl = document.getElementById(targetElementId);
    if (contentEl) {
        contentEl.innerHTML = await _generateReceiptHTML(transactionData, targetElementId === 'previewReceiptContent');
    }
}
window.generateReceiptContent = generateReceiptContent;

export async function printReceipt(isAutoPrint = false) {
    if (!window.app.isPrinterReady) {
        showToast('Fitur cetak tidak tersedia.');
        return;
    }
    if (!window.app.currentReceiptTransaction) {
        showToast('Tidak ada data struk untuk dicetak.');
        return;
    }
    
    try {
        if (!isAutoPrint) showToast('Menyiapkan struk...', 2000);
        const data = await generateReceiptEscPos(window.app.currentReceiptTransaction);
        sendToRawBT(data);
    } catch (error) {
        console.error('Print error:', error);
        if (!isAutoPrint) {
            showConfirmationModal(
                'Gagal Mencetak Struk',
                'Struk gagal dicetak. Ini bisa terjadi jika aplikasi RawBT tidak terinstall atau belum diatur.<br><br>Coba gunakan tombol "Share ke Printer" sebagai alternatif.',
                () => {},
                'Mengerti',
                'bg-blue-500'
            );
        }
    }
};

// NEW: WhatsApp Sharing Logic (Updated to Share Image)
export async function shareReceiptViaWhatsApp() {
    if (!window.app.currentReceiptTransaction) {
        showToast('Tidak ada data struk untuk dibagikan.');
        return;
    }
    
    if (typeof html2canvas === 'undefined') {
        showToast('Fitur share belum siap. Coba refresh halaman.');
        return;
    }

    const button = document.querySelector('#receiptModal button[onclick="shareReceiptViaWhatsApp()"]');
    let originalContent = '';
    if (button) {
        originalContent = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Memproses...`;
    }

    try {
        const receiptElement = document.getElementById('receiptContent');
        if (!receiptElement) throw new Error('Elemen struk tidak ditemukan');

        // Clone to capture full height without scrollbars
        const clone = receiptElement.cloneNode(true);
        Object.assign(clone.style, {
            position: 'absolute',
            top: '-9999px',
            left: '-9999px',
            width: 'auto', // Allow width to adjust to content
            minWidth: 'fit-content', // Ensure it captures full width of inner content
            display: 'inline-block', // Shrink wrap content
            height: 'auto',
            maxHeight: 'none',
            overflow: 'visible',
            backgroundColor: '#ffffff',
            padding: '20px', // Add padding for better look
            color: '#000000' // Ensure text is black
        });
        document.body.appendChild(clone);

        // Wait for images in the clone to load (e.g. logo)
        const images = clone.querySelectorAll('img');
        await Promise.all(Array.from(images).map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise(resolve => {
                img.onload = resolve;
                img.onerror = resolve; // Continue even if error
            });
        }));

        // Capture
        const canvas = await html2canvas(clone, {
            scale: 2, // Better resolution
            backgroundColor: '#ffffff',
            useCORS: false, // Use false for Data URLs usually
            logging: false
        });
        
        document.body.removeChild(clone);

        // Convert to Blob
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        const fileName = `Struk-${window.app.currentReceiptTransaction.id || Date.now()}.jpg`;
        const file = new File([blob], fileName, { type: 'image/jpeg' });

        // Web Share API Check & Intermediate Modal
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
             showConfirmationModal(
                'Struk Siap',
                'Gambar struk berhasil dibuat. Klik tombol di bawah untuk membuka menu Share.',
                async () => {
                    try {
                        await navigator.share({
                            files: [file],
                            title: 'Struk Belanja',
                            text: 'Terima kasih telah berbelanja.'
                        });
                    } catch (err) {
                        if (err.name !== 'AbortError') {
                            console.warn('Share API failed:', err);
                            showToast("Gagal membuka menu share.");
                        }
                    }
                },
                'Bagikan Sekarang',
                'bg-green-500'
            );
            return; // Exit here, don't download
        }
        
        // Fallback for desktop or unsupported browsers
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Prepare WhatsApp Link (Text Only fallback/helper)
        let phone = "";
        if (window.app.currentReceiptTransaction.customerId) {
            const customer = await getFromDB('contacts', window.app.currentReceiptTransaction.customerId);
            if (customer && customer.phone) {
                phone = customer.phone.replace(/^0/, '62').replace(/\+/g, '');
            }
        }
        
        showToast("Struk telah diunduh sebagai gambar.");
        
        if (phone) {
            setTimeout(() => {
                const text = "Struk pembelian terlampir.";
                const waUrl = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
                window.open(waUrl, '_blank');
            }, 1500);
        }

    } catch (error) {
        console.error("Share Error:", error);
        if (error.name !== 'AbortError') {
            showToast("Gagal membagikan struk.");
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.innerHTML = originalContent;
        }
    }
}

// NEW: Cashier Report Sharing Logic
export async function shareCashierReportViaWhatsApp() {
    if (!window.app.currentCashierReportData) {
        showToast('Tidak ada data laporan untuk dibagikan.');
        return;
    }
    
    if (typeof html2canvas === 'undefined') {
        showToast('Fitur share belum siap. Coba refresh halaman.');
        return;
    }

    const button = document.querySelector('#cashierReportModal button[onclick="shareCashierReportViaWhatsApp()"]');
    let originalContent = '';
    if (button) {
        originalContent = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Memproses...`;
    }

    try {
        const reportElement = document.getElementById('cashierReportContent');
        if (!reportElement) throw new Error('Elemen laporan tidak ditemukan');

        // Clone to capture full height without scrollbars
        const clone = reportElement.cloneNode(true);
        Object.assign(clone.style, {
            position: 'absolute',
            top: '-9999px',
            left: '-9999px',
            width: 'auto', // Allow width to adjust to content
            minWidth: 'fit-content', // Ensure it captures full width of inner content
            display: 'inline-block', // Shrink wrap content
            height: 'auto',
            maxHeight: 'none',
            overflow: 'visible',
            backgroundColor: '#ffffff',
            padding: '20px',
            color: '#000000' // Ensure text is black
        });
        
        // Ensure pre tag inside preserves whitespace and formatting
        const pre = clone.querySelector('pre');
        if (pre) {
            pre.style.whiteSpace = 'pre-wrap';
            pre.style.color = '#000000';
        }

        document.body.appendChild(clone);

        // Wait for images if any (reports usually don't have images but safe to include)
        const images = clone.querySelectorAll('img');
        await Promise.all(Array.from(images).map(img => {
            if (img.complete) return Promise.resolve();
            return new Promise(resolve => {
                img.onload = resolve;
                img.onerror = resolve;
            });
        }));

        // Capture
        const canvas = await html2canvas(clone, {
            scale: 2, // Better resolution
            backgroundColor: '#ffffff',
            useCORS: false,
            logging: false
        });
        
        document.body.removeChild(clone);

        // Convert to Blob
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
        const dateStr = new Date().toISOString().split('T')[0];
        const fileName = `Laporan-Kasir-${dateStr}.jpg`;
        const file = new File([blob], fileName, { type: 'image/jpeg' });

        // Web Share API Check & Intermediate Modal
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
             showConfirmationModal(
                'Laporan Siap',
                'Gambar laporan kasir berhasil dibuat. Klik tombol di bawah untuk membuka menu Share.',
                async () => {
                    try {
                        await navigator.share({
                            files: [file],
                            title: 'Laporan Tutup Kasir',
                            text: 'Laporan Tutup Kasir.'
                        });
                    } catch (err) {
                         if (err.name !== 'AbortError') {
                            console.warn('Share API failed:', err);
                            showToast("Gagal membuka menu share.");
                         }
                    }
                },
                'Bagikan Sekarang',
                'bg-green-500'
            );
            return; // Exit here
        }
        
        // Fallback for desktop or unsupported browsers
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showToast("Laporan telah diunduh sebagai gambar.");

    } catch (error) {
        console.error("Share Error:", error);
        if (error.name !== 'AbortError') {
            showToast("Gagal membagikan laporan.");
        }
    } finally {
        if (button) {
            button.disabled = false;
            button.innerHTML = originalContent;
        }
    }
}

async function generateLabelEscPos() {
    if (!window.app.isPrinterReady) {
        throw new Error('Printer library not loaded.');
    }
    
    // Check for pre-loaded html2canvas
    if (typeof html2canvas === 'undefined') {
        throw new Error('Fitur label belum siap. Coba lagi.');
    }

    const labelContent = document.getElementById('labelContent');
    if (!labelContent) {
        throw new Error('Label preview element not found.');
    }

    // Get printer settings
    const paperSize = await getSettingFromDB('printerPaperSize') || '80mm';
    const paperWidthDots = paperSize === '58mm' ? 384 : 576;

    // Render the preview div to a canvas
    const canvas = await html2canvas(labelContent, {
        scale: 2, // REDUCED scale for better performance
        backgroundColor: '#ffffff',
    });

    // Process the canvas for printing, similar to the logo logic
    const ratio = paperWidthDots / canvas.width;
    const w = paperWidthDots;
    const h = Math.round(canvas.height * ratio);

    const printCanvas = document.createElement('canvas');
    printCanvas.width = w;
    printCanvas.height = h;
    const ctx = printCanvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0, w, h);
    
    // Crop, binarize, and convert to raster format using existing helper functions
    const cropped = cropCanvasTopBottom(printCanvas, 245);
    const cctx = cropped.getContext('2d', { willReadFrequently: true });
    const src = cctx.getImageData(0, 0, cropped.width, cropped.height);
    
    const thr = 190; // A fixed threshold often works well for crisp text/barcode labels
    
    let mask = toMonoMask(src, thr);
    
    // Re-using the LOGO_DESPECKLE constant for consistency
    if (LOGO_DESPECKLE) {
        mask = despeckleMask(mask, cropped.width, cropped.height);
    }
    
    const { header, payload } = buildRasterGSv0(mask, cropped.width, cropped.height);

    // Create the final ESC/POS commands
    const encoder = new EscPosEncoder.default();
    encoder
        .initialize()
        .raw([0x1b, 0x40]) // Reset
        .align('center')
        .raw(Array.from(header))
        .raw(Array.from(payload))
        .feed(3)
        .cut();
        
    return encoder.encode();
}

export async function testPrint() {
    if (!window.app.isPrinterReady) {
        showToast('Fitur cetak tidak tersedia.');
        return;
    }
    try {
        const paperSize = await getSettingFromDB('printerPaperSize') || '80mm';
        const paperWidthChars = paperSize === '58mm' ? 32 : 42;
        const encoder = new EscPosEncoder.default();

        const data = encoder
            .initialize()
            .raw([0x1b, 0x40])
            .align('center')
            .width(2).height(2)
            .line('Test Cetak')
            .width(1).height(1)
            .line('----------------')
            .line('Printer terhubung!')
            .line(`Lebar kertas: ${paperWidthChars} karakter`)
            .line(new Date().toLocaleString('id-ID'))
            .feed(3)
            .cut()
            .encode();

        sendToRawBT(data);

    } catch(e) {
        showToast('Gagal melakukan test cetak.');
        console.error(e);
    }
};

export function showPrintHelpModal() {
    const modal = document.getElementById('printHelpModal');
    if (modal) modal.classList.remove('hidden');
};
export function closePrintHelpModal() {
    const modal = document.getElementById('printHelpModal');
    if (modal) modal.classList.add('hidden');
};

export async function showPreviewReceiptModal() {
    if (window.app.cart.items.length === 0) {
        showToast('Keranjang kosong, tidak ada struk untuk ditampilkan.');
        return;
    }
    
    const subtotalAfterDiscount = window.app.cart.items.reduce((sum, item) => {
        return sum + Math.round(item.effectivePrice * item.quantity);
    }, 0);

    let calculatedFees = [];
    let totalFeeAmount = 0;
    window.app.cart.fees.forEach(fee => {
        const feeAmountRaw = fee.type === 'percentage' ? subtotalAfterDiscount * (fee.value / 100) : fee.value;
        const roundedFeeAmount = Math.round(feeAmountRaw);
        calculatedFees.push({ ...fee, amount: roundedFeeAmount });
        totalFeeAmount += roundedFeeAmount;
    });
    
    const total = subtotalAfterDiscount + totalFeeAmount;

    const subtotal_raw = window.app.cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const totalDiscount_raw = window.app.cart.items.reduce((sum, item) => {
         const discountAmount = item.price * (item.discountPercentage / 100);
         return sum + (discountAmount * item.quantity);
    }, 0);

    const currentUser = window.app.currentUser;
    const previewData = {
        items: window.app.cart.items,
        subtotal: subtotal_raw,
        totalDiscount: totalDiscount_raw,
        fees: calculatedFees,
        total,
        cashPaid: 0,
        change: 0,
        customerName: window.app.cart.customerName,
        userName: currentUser ? currentUser.name : 'N/A',
        date: new Date().toISOString()
    };
    
    await generateReceiptContent(previewData, 'previewReceiptContent');
    document.getElementById('previewReceiptModal').classList.remove('hidden');
}

export function closePreviewReceiptModal() {
    document.getElementById('previewReceiptModal').classList.add('hidden');
}

export function updateFeatureAvailability() {
    const scanBtn = document.getElementById('scanBarcodeBtn');
    if (scanBtn) {
        if (!window.app.isScannerReady) {
            scanBtn.disabled = true;
            scanBtn.classList.remove('bg-gray-600');
            scanBtn.classList.add('bg-gray-400', 'cursor-not-allowed');
            scanBtn.title = 'Pemindai barcode gagal dimuat.';
        } else {
            scanBtn.disabled = false;
            scanBtn.classList.add('bg-gray-600');
            scanBtn.classList.remove('bg-gray-400', 'cursor-not-allowed');
            scanBtn.title = '';
        }
    }

    const printReceiptBtn = document.getElementById('printReceiptBtn');
    const autoPrintContainer = document.getElementById('autoPrintContainer');
    const testPrintBtn = document.getElementById('testPrintBtn');

    if (!window.app.isPrinterReady) {
        if (printReceiptBtn) {
            printReceiptBtn.disabled = true;
            printReceiptBtn.classList.remove('bg-gray-600');
            printReceiptBtn.classList.add('bg-gray-400', 'cursor-not-allowed');
            printReceiptBtn.title = 'Fitur cetak gagal dimuat.';
        }
        if (testPrintBtn) {
            testPrintBtn.disabled = true;
            testPrintBtn.title = 'Fitur cetak gagal dimuat.';
        }
        if (autoPrintContainer) {
            autoPrintContainer.classList.add('opacity-50');
            const autoPrintCheckbox = document.getElementById('autoPrintReceipt');
            if (autoPrintCheckbox) autoPrintCheckbox.disabled = true;

            if (!autoPrintContainer.parentElement.querySelector('.library-error-note')) {
                const note = document.createElement('p');
                note.className = 'text-xs text-red-500 text-center mt-2 library-error-note';
                note.textContent = 'Fitur cetak tidak tersedia (library gagal dimuat).';
                autoPrintContainer.parentElement.insertBefore(note, autoPrintContainer.nextSibling);
            }
        }
    }
}

// --- BARCODE / LABEL GENERATOR ---
export function setupBarcodeGenerator() {
    const generateBtn = document.getElementById('generateBarcodeLabelBtn');
    const downloadPngBtn = document.getElementById('downloadPngBtn');
    const printLabelBtn = document.getElementById('printLabelBtn');

    if (!generateBtn || !downloadPngBtn || !printLabelBtn) return;

    generateBtn.addEventListener('click', () => {
        const productName = document.getElementById('product-name').value.trim();
        const productPrice = document.getElementById('product-price').value.trim();
        const barcodeCode = document.getElementById('barcode-code').value.trim();

        if (!barcodeCode) {
            showToast('Teks/Angka untuk Barcode wajib diisi.');
            return;
        }

        const outputName = document.getElementById('output-product-name');
        const theOutputPrice = document.getElementById('output-product-price');
        const outputBarcodeText = document.getElementById('output-barcode-text');
        
        outputName.textContent = productName;
        theOutputPrice.textContent = productPrice ? `Rp ${formatCurrency(productPrice)}` : '';
        outputBarcodeText.textContent = barcodeCode;

        try {
            JsBarcode("#barcode", barcodeCode, {
                format: "CODE128",
                lineColor: "#000",
                width: 1.5,
                height: 25,
                displayValue: false,
                background: "transparent",
                margin: 0
            });
            document.getElementById('barcodeLabelOutput').classList.remove('hidden');
            document.getElementById('download-buttons').classList.remove('hidden');
        } catch (e) {
            showToast('Gagal membuat barcode. Pastikan teks valid.');
            console.error("JsBarcode error:", e);
        }
    });

    downloadPngBtn.addEventListener('click', async () => {
        if (typeof html2canvas === 'undefined') {
            showToast('Fitur label belum siap, coba sesaat lagi.');
            console.error('html2canvas is not loaded.');
            return;
        }
        const button = downloadPngBtn;
        button.disabled = true;
        button.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Memproses...`;
        
        try {
            const labelContent = document.getElementById('labelContent');
            const canvas = await html2canvas(labelContent, {
                scale: 2, // Reduced scale for better performance
                backgroundColor: '#ffffff'
            });
            const link = document.createElement('a');
            link.download = `label-${document.getElementById('barcode-code').value}.png`;
            link.href = canvas.toDataURL("image/png");
            link.click();
        } catch (e) {
            console.error('Download PNG failed:', e);
            showToast('Gagal mengunduh PNG. Coba lagi.');
        } finally {
            button.disabled = false;
            button.innerHTML = `<i class="fas fa-download mr-2"></i>Unduh PNG`;
        }
    });
    
    printLabelBtn.addEventListener('click', async () => {
        if (!window.app.isPrinterReady) {
            showToast('Fitur cetak tidak tersedia.');
            return;
        }
        
        const button = printLabelBtn;
        button.disabled = true;
        button.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Mencetak...`;

        try {
            const data = await generateLabelEscPos();
            sendToRawBT(data);
        } catch (e) {
            console.error('Print label failed:', e);
            showToast(e.message || 'Gagal mencetak label.');
        } finally {
            button.disabled = false;
            button.innerHTML = `<i class="fas fa-print mr-2"></i>Cetak Label`;
        }
    });
}


// --- CASHIER REPORT ---

// This function will be shared between HTML preview and ESC/POS generation
async function _generateCashierReportText(reportData) {
  const settings = await getAllFromDB('settings');
  const settingsMap = new Map(settings.map(s => [s.key, s.value]));

  const paperSize = settingsMap.get('printerPaperSize') || '80mm';
  const paperWidthChars = paperSize === '58mm' ? 32 : 42;

  const receiptLine = (char) => char.repeat(paperWidthChars);
  const formatLine = (left, right) => {
    const r = `Rp ${formatCurrency(right)}`;
    const spaces = Math.max(0, paperWidthChars - left.length - r.length);
    return left + ' '.repeat(spaces) + r;
  };
  
  const formatLineNoRp = (left, right) => {
    const spaces = Math.max(0, paperWidthChars - left.length - right.length);
    return left + ' '.repeat(spaces) + right;
  };

  let text = '';
  
  wrapAndCenter('LAPORAN TUTUP KASIR', paperWidthChars).forEach(l => text += l + '\n');
  text += receiptLine('=') + '\n';
  text += `Kasir   : ${reportData.cashierName}\n`;
  text += `Waktu   : ${formatReceiptDate(reportData.reportDate)}\n`;
  text += receiptLine('-') + '\n\n';

  text += centerPad('RINGKASAN PENJUALAN', paperWidthChars) + '\n';
  text += receiptLine('=') + '\n';
  text += formatLine('Penjualan (Omzet)', reportData.summary.totalOmzet) + '\n';
  text += receiptLine('=') + '\n';
  if (reportData.summary.totalDonasi > 0) {
      text += formatLine('Donasi Terkumpul', reportData.summary.totalDonasi) + '\n';
  }
  
  text += formatLine('Diterima (Tunai)', reportData.summary.totalReceivedCash) + '\n';
  text += formatLine('Kembalian', reportData.summary.totalChange) + '\n';
  text += receiptLine('=') + '\n';
  text += formatLine('TOTAL UANG (TUNAI)', reportData.summary.cashInHand) + '\n';
  text += formatLine('Diterima (QRIS)', reportData.summary.totalReceivedQris) + '\n';
  
  // Piutang (Bon) should appear after Diterima (QRIS)
  if (reportData.summary.totalNewReceivables > 0) {
      text += formatLine('Piutang (Bon)', reportData.summary.totalNewReceivables) + '\n';
  }

  if (reportData.summary.totalReceivableCollected > 0) {
      text += formatLine('Pelunasan Piutang', reportData.summary.totalReceivableCollected) + '\n';
  }
  if (reportData.summary.totalDebtPaid > 0) {
      text += formatLine('Pembayaran Hutang', -reportData.summary.totalDebtPaid) + '\n';
  }

  text += receiptLine('=') + '\n';
  text += `Total Transaksi: ${reportData.summary.totalTransactions}\n\n`;

  if (reportData.productSales.length > 0) {
      text += centerPad('RINCIAN PRODUK TERJUAL', paperWidthChars) + '\n';
      text += receiptLine('-') + '\n';
      reportData.productSales.forEach(([name, data]) => {
          const left = `${data.quantity}x ${name}`;
          const right = `Rp ${formatCurrency(data.total)}`;
          text += formatLineNoRp(left, right) + '\n';
      });
      text += '\n';
  }
  
  // Combined Ledger Section (Receivables & Debts)
  if (reportData.receivableCollections && reportData.receivableCollections.length > 0) {
      text += centerPad('MUTASI KAS LAINNYA', paperWidthChars) + '\n';
      text += receiptLine('-') + '\n';
      reportData.receivableCollections.forEach(item => {
          const sign = item.type === 'debt_payment' ? '-' : '+';
          text += formatLine(item.name, item.type === 'debt_payment' ? -item.amount : item.amount) + '\n';
      });
      text += '\n';
  }
  
  if (reportData.feeSummary.length > 0) {
      text += centerPad('RINCIAN PAJAK & BIAYA', paperWidthChars) + '\n';
      text += receiptLine('-') + '\n';
      reportData.feeSummary.forEach(([name, data]) => {
          text += formatLine(name, data.amount) + '\n';
      });
      text += '\n';
  }

  return text;
}


export async function generateCashierReportContent(reportData) {
    const contentEl = document.getElementById('cashierReportContent');
    if (contentEl) {
        // Fetch settings to determine correct width for preview
        const settings = await getAllFromDB('settings');
        const settingsMap = new Map(settings.map(s => [s.key, s.value]));
        const paperSize = settingsMap.get('printerPaperSize') || '80mm';
        // 80mm ~ 42 chars, 58mm ~ 32 chars
        const paperWidthChars = paperSize === '58mm' ? 32 : 42;

        const reportText = await _generateCashierReportText(reportData);
        
        const wrapper = document.createElement('div');
        // Set specific width to emulate printer paper width in characters (ch unit)
        wrapper.style.width = `${paperWidthChars}ch`;
        // Ensure monospace font and consistent styling
        wrapper.style.fontFamily = "ui-monospace, Menlo, Monaco, Consolas, 'Courier New', monospace";
        wrapper.style.lineHeight = '1.25';
        wrapper.style.margin = '0 auto';
        wrapper.style.backgroundColor = '#fff';
        
        const pre = document.createElement('pre');
        pre.style.margin = '0';
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.fontFamily = 'inherit';
        pre.style.fontSize = 'inherit';
        pre.textContent = reportText;
        
        wrapper.appendChild(pre);
        
        contentEl.innerHTML = '';
        contentEl.appendChild(wrapper);
        
        // Ensure parent allows horizontal scrolling if content is wider
        contentEl.style.overflowX = 'auto';
        contentEl.style.display = 'flex';
        contentEl.style.flexDirection = 'column';
        contentEl.style.alignItems = 'center';
    }
}
window.generateCashierReportContent = generateCashierReportContent;

async function generateCashierReportEscPos() {
    if (!window.app.isPrinterReady) throw new Error('Printer library not loaded.');
    if (!window.app.currentCashierReportData) throw new Error('No cashier report data.');

    const reportData = window.app.currentCashierReportData;
    const reportText = await _generateCashierReportText(reportData);

    const encoder = new EscPosEncoder.default();
    encoder
        .initialize()
        .raw([0x1b, 0x40]) // Reset
        .align('left')
        .raw([0x1b, 0x33, LINE_SPACING_DOTS]); // Line spacing

    reportText.split('\n').forEach(line => {
        encoder.line(line);
    });

    encoder.feed(3).cut();
    return encoder.encode();
}

export async function printCashierReport() {
    if (!window.app.isPrinterReady || !window.app.currentCashierReportData) {
        showToast('Tidak ada data laporan untuk dicetak.');
        return;
    }

    try {
        showToast('Mencetak laporan...', 2000);
        const data = await generateCashierReportEscPos();
        sendToRawBT(data);
    } catch (error) {
        console.error('Print cashier report error:', error);
        showToast('Gagal mencetak laporan kasir.');
    }
}

export function closeCashierReportModal() {
    const modal = document.getElementById('cashierReportModal');
    if (modal) {
        modal.classList.add('hidden');
        window.app.currentCashierReportData = null;
    }
}
