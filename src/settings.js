

import { putToDB, getAllFromDB, getFromDB, getSettingFromDB, putSettingToDB, clearAllStores, getFromDBByIndex } from './db.js';
import { showToast, showConfirmationModal, showPage, loadDashboard, updateUiForRole } from './ui.js';
import { queueSyncAction } from './sync.js';
import { updateCartDisplay } from './cart.js';
import { loadProductsList } from './product.js';

let pinLockoutInterval = null;
const FAILED_ATTEMPTS_LIMIT = 5;
let sessionListenerUnsubscribe = null;

// Safe JSON Stringify to handle circular references robustly
function safeJSONStringify(obj, indent = 2) {
    const cache = new Set();
    return JSON.stringify(obj, (key, value) => {
        try {
            if (typeof value === 'object' && value !== null) {
                if (cache.has(value)) {
                    // Circular reference found, replace with placeholder
                    return '[Circular]';
                }
                cache.add(value);
            }
        } catch (e) {
            return '[Error]';
        }
        return value;
    }, indent);
}

function sanitizeFee(fee) {
    if (!fee) return null;
    return {
        id: fee.id,
        serverId: fee.serverId,
        name: fee.name,
        type: fee.type,
        value: fee.value,
        isDefault: fee.isDefault,
        isTax: fee.isTax,
        createdAt: fee.createdAt,
    };
}

async function claimSession(uid, email) {
    const sessionId = Date.now().toString() + "_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('active_session_id', sessionId);
    
    console.log("[SESSION] Claiming session:", sessionId);

    try {
        await window.db_firestore.collection('users').doc(uid).set({
            currentSessionId: sessionId,
            lastLogin: new Date().toISOString(),
            email: email
        }, { merge: true });
    } catch (fsError) {
        // Log minimal info to avoid circular error
        console.warn("[SESSION] Write failed (permissions?):", fsError.code);
    }
    
    return sessionId;
}

function startSessionMonitoring(uid) {
    if (sessionListenerUnsubscribe) {
        sessionListenerUnsubscribe();
    }

    const localSessionId = localStorage.getItem('active_session_id');
    if (!localSessionId) return;

    console.log("[SESSION] Monitoring started for:", uid, "Local ID:", localSessionId);

    sessionListenerUnsubscribe = window.db_firestore.collection('users').doc(uid).onSnapshot((doc) => {
        if (doc.exists) {
            const serverData = doc.data();
            const serverSessionId = serverData.currentSessionId;

            if (serverSessionId && serverSessionId !== localSessionId) {
                console.warn("[SESSION] Conflict detected! Device active on another session.");
                
                if (sessionListenerUnsubscribe) {
                    sessionListenerUnsubscribe();
                    sessionListenerUnsubscribe = null;
                }

                localStorage.removeItem('active_session_id');

                window.showConfirmationModal(
                    '<i class="fas fa-exclamation-circle text-red-500"></i> Sesi Berakhir',
                    'Akun Anda telah login di perangkat lain. Koneksi diputus untuk menghemat penggunaan database.',
                    () => {
                        window.app.currentUser = null;
                        firebase.auth().signOut();
                        safeReload();
                    },
                    'Muat Ulang',
                    'bg-red-600',
                    false 
                );
            }
        }
    }, (error) => {
        if (error.code === 'permission-denied') {
            console.warn("[SESSION] Monitoring disabled: Insufficient permissions to read user session data.");
        } else {
            // Avoid logging full error object which might contain circular references (e.g. Firestore internals)
            // Explicitly log primitive properties to be safe
            console.error("[SESSION] Monitor error:", error.code, error.message);
        }
    });
}

// Helper untuk reload aman
function safeReload() {
    // Jika online, lakukan reload biasa agar mendapat update terbaru
    if (navigator.onLine) {
        window.location.reload();
    } else {
        // Jika offline, lakukan "Soft Reload" untuk menghindari halaman "No Internet"
        // 1. Reset Cache State
        window.app.productsCache = []; 
        window.app.cart = { items: [], fees: [], customerId: null, customerName: null };
        
        // 2. Refresh UI berdasarkan halaman aktif
        window.showToast('Data diperbarui (Mode Offline).', 3000);
        
        if (window.app.currentPage === 'dashboard') {
            import('./ui.js').then(m => m.loadDashboard());
        } else if (window.app.currentPage === 'produk') {
            import('./product.js').then(m => m.loadProductsList(true));
        } else if (window.app.currentPage === 'kasir') {
            import('./product.js').then(m => m.loadProductsGrid());
        }
    }
}

export async function saveStoreSettings() {
    const settings = [
        { key: 'storeName', value: (document.getElementById('storeName')).value.trim() },
        { key: 'storeAddress', value: (document.getElementById('storeAddress')).value.trim() },
        { key: 'storeFeedbackPhone', value: (document.getElementById('storeFeedbackPhone')).value.trim() },
        { key: 'storeFooterText', value: (document.getElementById('storeFooterText')).value.trim() },
        { key: 'couponMinPurchase', value: parseFloat((document.getElementById('couponMinPurchase')).value) || 0 },
        { key: 'couponText', value: (document.getElementById('couponText')).value.trim() },
        { key: 'storeLogo', value: window.app.currentStoreLogoData },
        { key: 'showLogoOnReceipt', value: document.getElementById('showLogoOnReceipt').checked },
        { key: 'lowStockThreshold', value: parseInt((document.getElementById('lowStockThreshold')).value) || 5 },
        { key: 'autoPrintReceipt', value: document.getElementById('autoPrintReceipt').checked },
        { key: 'printerPaperSize', value: document.getElementById('printerPaperSize').value },
        { key: 'autoOpenCashDrawer', value: document.getElementById('autoOpenCashDrawer').checked },
        { key: 'enableDonationRounding', value: document.getElementById('enableDonationRounding').checked },
        { key: 'autoBackupOnClose', value: document.getElementById('autoBackupOnClose').checked },
        { key: 'exportBackupReminder', value: document.getElementById('exportBackupReminder').checked },
        { key: 'exportBackupInterval', value: parseInt(document.getElementById('exportBackupInterval').value) || 7 },
        { key: 'pointSystemEnabled', value: document.getElementById('pointSystemEnabled').checked },
        { key: 'pointMinPurchase', value: parseInt(document.getElementById('pointMinPurchase').value) || 0 },
        { key: 'pointValuePerPoint', value: parseInt(document.getElementById('pointValuePerPoint').value) || 0 },
        { key: 'useExternalScanner', value: document.getElementById('useExternalScanner').checked }
    ];

    try {
        const transaction = window.app.db.transaction('settings', 'readwrite');
        const store = transaction.objectStore('settings');
        settings.forEach(setting => store.put(setting));
        
        transaction.oncomplete = () => {
            const lowStockSetting = settings.find(s => s.key === 'lowStockThreshold');
            const externalScannerSetting = settings.find(s => s.key === 'useExternalScanner');
            
            window.app.lowStockThreshold = lowStockSetting.value;
            window.app.useExternalScanner = externalScannerSetting.value;
            
            window.showToast('Pengaturan berhasil disimpan');
            window.loadDashboard();
        };
    } catch(error) {
        console.error("Failed to save settings:", error);
        window.showToast("Gagal menyimpan pengaturan.");
    }
}

export async function loadSettings() {
    try {
        const settings = await getAllFromDB('settings');
        const settingsMap = new Map(settings.map(s => [s.key, s.value]));

        (document.getElementById('storeName')).value = settingsMap.get('storeName') || '';
        (document.getElementById('storeAddress')).value = settingsMap.get('storeAddress') || '';
        (document.getElementById('storeFeedbackPhone')).value = settingsMap.get('storeFeedbackPhone') || '';
        (document.getElementById('storeFooterText')).value = settingsMap.get('storeFooterText') || '';
        (document.getElementById('couponMinPurchase')).value = settingsMap.get('couponMinPurchase') || '';
        (document.getElementById('couponText')).value = settingsMap.get('couponText') || '';
        (document.getElementById('lowStockThreshold')).value = settingsMap.get('lowStockThreshold') || 5;
        document.getElementById('autoPrintReceipt').checked = settingsMap.get('autoPrintReceipt') || false;
        document.getElementById('showLogoOnReceipt').checked = settingsMap.get('showLogoOnReceipt') !== false;
        document.getElementById('printerPaperSize').value = settingsMap.get('printerPaperSize') || '80mm';
        const autoOpenCashDrawerToggle = document.getElementById('autoOpenCashDrawer');
        if (autoOpenCashDrawerToggle) {
            autoOpenCashDrawerToggle.checked = settingsMap.get('autoOpenCashDrawer') || false;
        }
        const enableDonationRoundingToggle = document.getElementById('enableDonationRounding');
        if (enableDonationRoundingToggle) {
            enableDonationRoundingToggle.checked = settingsMap.get('enableDonationRounding') || false;
        }

        const autoBackupOnCloseToggle = document.getElementById('autoBackupOnClose');
        if (autoBackupOnCloseToggle) {
            autoBackupOnCloseToggle.checked = settingsMap.get('autoBackupOnClose') !== false;
        }

        const exportBackupReminderToggle = document.getElementById('exportBackupReminder');
        const exportIntervalContainer = document.getElementById('exportIntervalContainer');
        const exportBackupIntervalInput = document.getElementById('exportBackupInterval');

        if (exportBackupReminderToggle && exportIntervalContainer && exportBackupIntervalInput) {
            const isChecked = settingsMap.get('exportBackupReminder') || false;
            exportBackupReminderToggle.checked = isChecked;
            exportBackupIntervalInput.value = settingsMap.get('exportBackupInterval') || 7;
            exportIntervalContainer.style.display = isChecked ? 'block' : 'none';
        }

        const pointSystemEnabledToggle = document.getElementById('pointSystemEnabled');
        const pointSystemSettingsDiv = document.getElementById('pointSystemSettings');
        if (pointSystemEnabledToggle && pointSystemSettingsDiv) {
            const isEnabled = settingsMap.get('pointSystemEnabled') || false;
            pointSystemEnabledToggle.checked = isEnabled;
            pointSystemSettingsDiv.style.display = isEnabled ? 'block' : 'none';
        }
        document.getElementById('pointMinPurchase').value = settingsMap.get('pointMinPurchase') || '';
        document.getElementById('pointValuePerPoint').value = settingsMap.get('pointValuePerPoint') || '';

        const externalScannerToggle = document.getElementById('useExternalScanner');
        if (externalScannerToggle) {
            const isExternal = settingsMap.get('useExternalScanner') || false;
            externalScannerToggle.checked = isExternal;
            window.app.useExternalScanner = isExternal;
        }

        window.app.lowStockThreshold = settingsMap.get('lowStockThreshold') || 5;
        
        window.app.currentStoreLogoData = settingsMap.get('storeLogo') || null;
        if (window.app.currentStoreLogoData) {
            (document.getElementById('storeLogoPreview')).innerHTML = `<img src="${window.app.currentStoreLogoData}" alt="Logo Preview" class="image-preview">`;
        }
    } catch (error) {
        console.error("Failed to load settings:", error);
    }
}

export function previewStoreLogo(event) {
    const file = event.target.files?.[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            window.app.currentStoreLogoData = e.target?.result;
            (document.getElementById('storeLogoPreview')).innerHTML = `<img src="${window.app.currentStoreLogoData}" alt="Logo Preview" class="image-preview">`;
        };
        reader.readAsDataURL(file);
    }
}

export async function resetDonationCounter() {
    window.showConfirmationModal(
        'Reset Donasi',
        'Anda yakin ingin mereset total donasi terkumpul di Dasbor? Perhitungan akan dimulai dari 0 mulai sekarang.',
        async () => {
            await putSettingToDB({ key: 'lastDonationResetDate', value: new Date().toISOString() });
            window.showToast('Counter donasi berhasil direset.');
            window.loadDashboard();
        },
        'Ya, Reset',
        'bg-pink-500'
    );
}

// --- DATA MANAGEMENT ---
export async function exportData(isAuto = false) {
    try {
        const sanitizeFlat = (items) => items.map(item => ({ ...item }));
        const sanitizeTransactions = (transactions) => {
            return transactions.map(t => ({
                id: t.id,
                subtotal: t.subtotal,
                totalDiscount: t.totalDiscount,
                total: t.total,
                cashPaid: t.cashPaid,
                change: t.change,
                paymentMethod: t.paymentMethod,
                userId: t.userId,
                userName: t.userName,
                date: t.date,
                items: (t.items || []).map(item => ({
                    id: item.id,
                    name: item.name,
                    quantity: item.quantity,
                    price: item.price,
                    effectivePrice: item.effectivePrice,
                    discountPercentage: item.discountPercentage
                })),
                fees: (t.fees || []).map(fee => ({
                    id: fee.id,
                    name: fee.name,
                    type: fee.type,
                    value: fee.value,
                    isDefault: fee.isDefault,
                    isTax: fee.isTax,
                    createdAt: fee.createdAt,
                    amount: fee.amount
                }))
            }));
        };

        const products = sanitizeFlat(await getAllFromDB('products'));
        const transactions = sanitizeTransactions(await getAllFromDB('transactions'));
        const settings = sanitizeFlat(await getAllFromDB('settings'));
        const categories = sanitizeFlat(await getAllFromDB('categories'));
        const fees = sanitizeFlat(await getAllFromDB('fees'));
        const contacts = sanitizeFlat(await getAllFromDB('contacts'));
        const ledgers = sanitizeFlat(await getAllFromDB('ledgers'));
        const users = sanitizeFlat(await getAllFromDB('users'));
        const stockHistory = sanitizeFlat(await getAllFromDB('stock_history'));
        const expenses = sanitizeFlat(await getAllFromDB('expenses'));
        
        const data = {
            products,
            transactions,
            settings,
            categories,
            fees,
            contacts,
            ledgers,
            users,
            stockHistory,
            expenses,
            exportDate: new Date().toISOString()
        };
        
        // Robust serialization
        let fileContent;
        try {
            fileContent = safeJSONStringify(data, 2);
        } catch (jsonError) {
             console.error('JSON Stringify failed:', jsonError);
             window.showToast('Gagal memproses data. Cek konsol.');
             return;
        }
        
        const date = new Date().toISOString().split('T')[0];
        const fileName = isAuto ? `pos_backup_auto_${date}.json` : `pos_backup_${date}.json`;

        if (window.AndroidDownloader) {
            window.AndroidDownloader.downloadFile(fileContent, fileName, 'application/json');
        } else {
            const blob = new Blob([fileContent], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        
        if (isAuto) {
            window.showToast('Backup otomatis tersimpan di Download.');
        } else {
            window.showToast('Export data berhasil.');
        }
        
        await putSettingToDB({ key: 'lastExportDate', value: new Date().toISOString() });
    } catch (error) {
        console.error('Export failed:', error);
        window.showToast('Gagal mengexport data.');
    }
}

export function importData() {
    (document.getElementById('importFile')).click();
}

export function handleImport(event) {
    const file = event.target.files?.[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                window.showConfirmationModal(
                    'Import Data',
                    'Ini akan menimpa semua data saat ini. Apakah Anda yakin ingin melanjutkan?',
                    async () => {
                        const storesToClear = ['products', 'transactions', 'settings', 'categories', 'fees', 'contacts', 'ledgers', 'users', 'stock_history', 'expenses'];
                        const transaction = window.app.db.transaction(storesToClear, 'readwrite');
                        
                        storesToClear.forEach(storeName => {
                            if (data[storeName]) {
                                transaction.objectStore(storeName).clear();
                            }
                        });
                        
                        if (data.products) data.products.forEach(p => transaction.objectStore('products').put(p));
                        if (data.transactions) data.transactions.forEach(t => transaction.objectStore('transactions').put(t));
                        if (data.settings) data.settings.forEach(s => transaction.objectStore('settings').put(s));
                        if (data.categories) data.categories.forEach(c => transaction.objectStore('categories').put(c));
                        if (data.fees) data.fees.forEach(f => transaction.objectStore('fees').put(f));
                        if (data.contacts) data.contacts.forEach(c => transaction.objectStore('contacts').put(c));
                        if (data.ledgers) data.ledgers.forEach(l => transaction.objectStore('ledgers').put(l));
                        if (data.users) data.users.forEach(u => transaction.objectStore('users').put(u));
                        if (data.stockHistory) data.stockHistory.forEach(s => transaction.objectStore('stock_history').put(s));
                        if (data.expenses) data.expenses.forEach(e => transaction.objectStore('expenses').put(e));
                        
                        transaction.oncomplete = () => {
                            window.showToast('Data berhasil diimport. Memuat ulang...');
                            // Use safeReload instead of direct location.reload
                            setTimeout(() => safeReload(), 2000);
                        };
                    },
                    'Ya, Import',
                    'bg-purple-500'
                );
            } catch (error) {
                console.error('Import parse error:', error);
                window.showToast('Format file tidak valid.');
            }
        };
        reader.readAsText(file);
    }
}

export function clearAllData() {
    window.showConfirmationModal(
        'Hapus Semua Data',
        'PERINGATAN: Ini akan menghapus semua produk, transaksi, dan pengaturan secara permanen. Tindakan ini tidak dapat dibatalkan. Apakah Anda benar-benar yakin?',
        async () => {
            await clearAllStores();
            window.showToast('Semua data berhasil dihapus. Memuat ulang...');
            // Use safeReload instead of direct location.reload
            setTimeout(() => safeReload(), 2000);
        },
        'Ya, Hapus Semua',
        'bg-red-500'
    );
}

export function showImportProductsModal() {
    document.getElementById('importProductsModal').classList.remove('hidden');
}

export function closeImportProductsModal() {
    const modal = document.getElementById('importProductsModal');
    if (modal) modal.classList.add('hidden');
    const fileInput = document.getElementById('importProductsFile');
    if (fileInput) fileInput.value = '';
}

function parseCSV(text) {
    const arr = [];
    let quote = false;
    for (let row = 0, col = 0, c = 0; c < text.length; c++) {
        let cc = text[c], nc = text[c+1];
        arr[row] = arr[row] || [];
        arr[row][col] = arr[row][col] || '';

        if (cc == '"' && quote && nc == '"') { arr[row][col] += cc; ++c; continue; }
        if (cc == '"') { quote = !quote; continue; }
        if (cc == ',' && !quote) { ++col; continue; }
        if (cc == '\r' && nc == '\n' && !quote) { ++row; col = 0; ++c; continue; }
        if (cc == '\n' && !quote) { ++row; col = 0; continue; }
        if (cc == '\r' && !quote) { ++row; col = 0; continue; }

        arr[row][col] += cc;
    }
    return arr;
}

export async function handleProductImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const csvText = e.target.result.replace(/^\uFEFF/, '');
            let parsedRows = parseCSV(csvText);
            
            parsedRows = parsedRows.filter(row => row.length > 0 && row.some(cell => cell.trim() !== ''));

            if (parsedRows.length < 2) {
                window.showToast('File CSV kosong atau hanya berisi header.');
                return;
            }

            const headerRow = parsedRows[0];
            const header = headerRow.map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
            
            const requiredHeaders = ['nama', 'harga_jual'];
            if (!requiredHeaders.every(h => header.includes(h))) {
                window.showToast(`Header CSV tidak valid. Wajib ada: ${requiredHeaders.join(', ')}`);
                return;
            }

            window.showToast('Memulai proses import...', 2000);
            closeImportProductsModal();

            const existingProducts = await getAllFromDB('products');
            const productNameMap = new Map(existingProducts.map(p => [p.name.toLowerCase(), p]));
            const productBarcodeMap = new Map(existingProducts.filter(p => p.barcode).map(p => [p.barcode, p]));
            
            const existingCategories = await getAllFromDB('categories');
            const categoryNameMap = new Map(existingCategories.map(c => [c.name.toLowerCase(), c]));
            
            let errorCount = 0;
            let addedCount = 0;
            let updatedCount = 0;

            const productsData = parsedRows.slice(1).map(values => {
                 return header.reduce((obj, col, index) => {
                    obj[col] = values[index] ? values[index].trim() : '';
                    return obj;
                }, {});
            });

            window.showToast('Menyimpan data ke database...', 5000);

            for (const [index, rowData] of productsData.entries()) {
                try {
                    if (!rowData.nama) {
                        throw new Error("Baris tidak valid: Nama wajib diisi.");
                    }
                    
                    const barcode = rowData.barcode ? rowData.barcode.trim() : null;
                    let product;
                    let isUpdate = false;

                    const productByName = productNameMap.get(rowData.nama.toLowerCase());
                    const productByBarcode = barcode ? productBarcodeMap.get(barcode) : null;
                    
                    if (productByBarcode) {
                        product = productByBarcode;
                        isUpdate = true;
                    } else if (productByName) {
                        product = productByName;
                        isUpdate = true;
                    } else {
                        product = { createdAt: new Date().toISOString() };
                    }
                    
                    if (barcode) {
                        const conflictingProduct = await getFromDBByIndex('products', 'barcode', barcode);
                        if (conflictingProduct && conflictingProduct.id !== product.id) {
                            throw new Error(`Barcode '${barcode}' sudah digunakan oleh produk '${conflictingProduct.name}'.`);
                        }
                    }

                    product.name = rowData.nama;
                    product.price = parseFloat(rowData.harga_jual);
                    if (isNaN(product.price)) product.price = 0;

                    product.purchasePrice = parseFloat(rowData.harga_beli) || product.purchasePrice || 0;
                    product.stock = parseInt(rowData.stok) >= 0 ? parseInt(rowData.stok) : (product.stock || 0);
                    product.barcode = barcode;
                    product.category = rowData.kategori || product.category || 'Lainnya';
                    
                    if (rowData.diskon_persen) {
                        product.discountPercentage = parseFloat(rowData.diskon_persen) || 0;
                    } else if (!isUpdate) {
                        product.discountPercentage = 0;
                    }

                    product.updatedAt = new Date().toISOString();
                    
                    if (!isUpdate && !product.image) {
                        product.image = null;
                    }

                    if (!isUpdate) {
                        product.wholesalePrices = [];
                    }

                    const categoryName = product.category;
                    if (categoryName && !categoryNameMap.has(categoryName.toLowerCase())) {
                        const newCategory = { name: categoryName, createdAt: new Date().toISOString() };
                        const savedCatId = await putToDB('categories', newCategory);
                        const savedCategory = { ...newCategory, id: savedCatId };
                        categoryNameMap.set(categoryName.toLowerCase(), savedCategory);
                    }
                    
                    const savedProductId = await putToDB('products', product);
                    
                    if (!isUpdate) {
                       const newProduct = { ...product, id: savedProductId };
                       productNameMap.set(newProduct.name.toLowerCase(), newProduct);
                       if (newProduct.barcode) {
                           productBarcodeMap.set(newProduct.barcode, newProduct);
                       }
                    }

                    if (isUpdate) {
                        updatedCount++;
                    } else {
                        addedCount++;
                    }

                } catch(error) {
                    console.error("Gagal mengimpor baris:", rowData, "Error:", error.message);
                    errorCount++;
                }
            }

            let summary = `Import selesai.`;
            if (addedCount > 0) summary += ` ${addedCount} produk ditambah.`;
            if (updatedCount > 0) summary += ` ${updatedCount} produk diperbarui.`;
            if (errorCount > 0) summary += ` ${errorCount} baris gagal (cek konsol).`;
            window.showToast(summary, 5000);
            
            // Reload aplikasi untuk memastikan data terupdate sepenuhnya
            setTimeout(() => safeReload(), 2000);

        } catch (error) {
            console.error('Import failed:', error);
            window.showToast('Gagal memproses file. Pastikan formatnya benar.');
        } finally {
            event.target.value = '';
        }
    };
    reader.readAsText(file);
}

export async function addFee() {
    const nameInput = document.getElementById('feeName');
    const typeInput = document.getElementById('feeType');
    const valueInput = document.getElementById('feeValue');
    const isDefaultInput = document.getElementById('feeIsDefault');

    const name = nameInput.value.trim();
    const type = typeInput.value;
    const value = parseFloat(valueInput.value);
    const isDefault = isDefaultInput.checked;

    if (!name || isNaN(value) || value < 0) {
        window.showToast('Nama dan Nilai Biaya harus diisi dengan benar.');
        return;
    }

    const newFee = {
        name,
        type,
        value,
        isDefault,
        isTax: name.toLowerCase().includes('pajak') || name.toLowerCase().includes('ppn'),
        createdAt: new Date().toISOString()
    };

    try {
        const addedId = await putToDB('fees', newFee);
        await queueSyncAction('CREATE_FEE', { ...newFee, id: addedId });
        window.showToast('Biaya berhasil ditambahkan.');
        nameInput.value = '';
        valueInput.value = '';
        isDefaultInput.checked = false;
        await loadFees();
    } catch (error) {
        console.error('Failed to add fee:', error);
        window.showToast('Gagal menambahkan biaya.');
    }
}

export async function loadFees() {
    const feesListEl = document.getElementById('feesList');
    const fees = await getAllFromDB('fees');
    
    if (fees.length === 0) {
        feesListEl.innerHTML = '<p class="text-gray-500 text-center py-2">Belum ada pajak atau biaya.</p>';
        return;
    }

    feesListEl.innerHTML = fees.map(fee => {
        const valueDisplay = fee.type === 'percentage'
            ? `${fee.value}%`
            : `Rp ${window.formatCurrency(fee.value)}`;
        
        const defaultBadge = fee.isDefault ? '<span class="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">Otomatis</span>' : '';

        return `
            <div class="flex justify-between items-center bg-gray-100 p-2 rounded-lg">
                <div>
                    <p class="font-semibold">${fee.name}</p>
                    <p class="text-sm text-gray-600">${valueDisplay}</p>
                </div>
                <div class="flex items-center gap-2">
                    ${defaultBadge}
                    <button onclick="deleteFee(${fee.id})" class="text-red-500 clickable"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `;
    }).join('');
}


export async function deleteFee(id) {
    window.showConfirmationModal('Hapus Biaya', 'Yakin ingin menghapus biaya ini?', async () => {
         try {
            const feeToDelete = await getFromDB('fees', id);
            const tx = window.app.db.transaction('fees', 'readwrite');
            tx.objectStore('fees').delete(id);
            tx.oncomplete = async () => {
                await queueSyncAction('DELETE_FEE', sanitizeFee(feeToDelete));
                window.showToast('Biaya berhasil dihapus.');
                loadFees();
            };
        } catch (error) {
            console.error('Failed to delete fee:', error);
            window.showToast('Gagal menghapus biaya.');
        }
    });
}


export async function showFeeSelectionModal() {
    const feeSelectionList = document.getElementById('feeSelectionList');
    const fees = await getAllFromDB('fees');
    
    if (fees.length === 0) {
        feeSelectionList.innerHTML = '<p class="text-gray-500 text-center py-4">Tidak ada pajak atau biaya yang dapat dipilih. Tambahkan terlebih dahulu di halaman Pengaturan.</p>';
    } else {
        feeSelectionList.innerHTML = fees.map(fee => {
            const isChecked = window.app.cart.fees.some(cartFee => cartFee.id === fee.id);
            return `
                <label class="flex items-center justify-between p-3 bg-gray-50 rounded-lg cursor-pointer">
                    <div>
                        <span class="font-semibold">${fee.name}</span>
                        <p class="text-sm text-gray-500">${fee.type === 'percentage' ? `${fee.value}%` : `Rp ${window.formatCurrency(fee.value)}`}</p>
                    </div>
                    <input type="checkbox" data-fee-id="${fee.id}" class="h-5 w-5 rounded text-blue-600 border-gray-300 focus:ring-blue-500" ${isChecked ? 'checked' : ''}>
                </label>
            `;
        }).join('');
    }
    (document.getElementById('feeSelectionModal')).classList.remove('hidden');
}

export function closeFeeSelectionModal() {
    (document.getElementById('feeSelectionModal')).classList.add('hidden');
}

export async function applySelectedFees() {
    const checkboxes = document.querySelectorAll('#feeSelectionList input[type="checkbox"]');
    const allFees = await getAllFromDB('fees');
    
    const selectedFeeIds = Array.from(checkboxes)
        .filter(cb => cb.checked)
        .map(cb => parseInt(cb.dataset.feeId));

    window.app.cart.fees = allFees.filter(fee => selectedFeeIds.includes(fee.id));
    
    window.updateCartDisplay();
    closeFeeSelectionModal();
    window.showToast('Pajak & biaya berhasil diperbarui.');
}


export async function applyDefaultFees() {
    const allFees = await getAllFromDB('fees');
    window.app.cart.fees = allFees.filter(fee => fee.isDefault);
}

export async function reconcileCartFees() {
    const allFees = await getAllFromDB('fees');
    const allFeesMap = new Map(allFees.map(f => [f.id, f]));

    const reconciledFees = [];
    const addedFeeIds = new Set();

    window.app.cart.fees.forEach(cartFee => {
        if (allFeesMap.has(cartFee.id)) {
            reconciledFees.push(allFeesMap.get(cartFee.id));
            addedFeeIds.add(cartFee.id);
        }
    });

    allFees.forEach(dbFee => {
        if (dbFee.isDefault && !addedFeeIds.has(dbFee.id)) {
            reconciledFees.push(dbFee);
            addedFeeIds.add(dbFee.id);
        }
    });
    
    window.app.cart.fees = reconciledFees;
}

function setKeypadDisabled(disabled) {
    const keypad = document.getElementById('pinKeypad');
    if (!keypad) return;
    keypad.querySelectorAll('button').forEach(btn => {
        btn.disabled = disabled;
    });
    if (disabled) {
        keypad.classList.add('opacity-50', 'pointer-events-none');
    } else {
        keypad.classList.remove('opacity-50', 'pointer-events-none');
    }
}

function updateLockoutTimer(endTime) {
    const lockoutMessageEl = document.getElementById('pinLockoutMessage');
    const remainingMs = endTime - Date.now();

    if (remainingMs <= 0) {
        clearInterval(pinLockoutInterval);
        pinLockoutInterval = null;
        lockoutMessageEl.classList.add('hidden');
        setKeypadDisabled(false);
        localStorage.removeItem('pinLockoutEndTime');
        localStorage.setItem('pinFailedAttempts', '0');
    } else {
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(remainingSeconds / 60);
        const seconds = remainingSeconds % 60;
        lockoutMessageEl.textContent = `Terlalu banyak percobaan. ${minutes > 0 ? `${minutes} menit ` : ''}${seconds} detik.`;
    }
}

function startPinLockout(endTime) {
    const lockoutMessageEl = document.getElementById('pinLockoutMessage');
    setKeypadDisabled(true);
    lockoutMessageEl.classList.remove('hidden');

    if (pinLockoutInterval) {
        clearInterval(pinLockoutInterval);
    }
    updateLockoutTimer(endTime);
    pinLockoutInterval = setInterval(() => updateLockoutTimer(endTime), 1000);
}

function checkPinLockout() {
    const endTime = parseInt(localStorage.getItem('pinLockoutEndTime') || '0');
    if (endTime > Date.now()) {
        startPinLockout(endTime);
    } else {
        setKeypadDisabled(false);
        document.getElementById('pinLockoutMessage').classList.add('hidden');
    }
}

function resetPinInput() {
    window.app.currentPinInput = "";
    const pinDisplay = document.getElementById('pinDisplay');
    pinDisplay.innerHTML = `
        <div class="w-4 h-4 rounded-full border-2 border-gray-400"></div>
        <div class="w-4 h-4 rounded-full border-2 border-gray-400"></div>
        <div class="w-4 h-4 rounded-full border-2 border-gray-400"></div>
        <div class="w-4 h-4 rounded-full border-2 border-gray-400"></div>
    `;
    pinDisplay.classList.remove('animate-shake');
}

export async function initiatePinLoginFlow(firebaseUser) {
    const authInfo = document.getElementById('authInfo');
    if (authInfo) {
        authInfo.textContent = '';
        authInfo.classList.add('hidden');
    }

    document.getElementById('authContainer')?.classList.add('hidden');
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay.style.display !== 'none') {
        loadingOverlay.classList.add('opacity-0');
        setTimeout(() => loadingOverlay.style.display = 'none', 300);
    }

    if (firebaseUser.isAnonymous) {
        console.warn("Anonymous user detected, but guest login is disabled. Forcing logout.");
        firebase.auth().signOut();
        return;
    }
    
    const localSessionId = localStorage.getItem('active_session_id');
    if (!localSessionId) {
        await claimSession(firebaseUser.uid, firebaseUser.email);
    }
    startSessionMonitoring(firebaseUser.uid);

    const allUsers = await getAllFromDB('users');
    if (allUsers.length === 0) {
        console.log("No local users found. Initiating first-time PIN setup for owner.");
        document.getElementById('setDevicePinModal').classList.remove('hidden');
    } else {
        console.log("Local users found. Showing PIN login screen.");
        document.getElementById('loginModal').classList.remove('hidden');
        resetPinInput();
        checkPinLockout();
    }
}

export async function handleInitialPinSetup() {
    const pin = document.getElementById('setPinInput').value;
    const confirmPin = document.getElementById('confirmPinInput').value;
    const errorEl = document.getElementById('pinSetError');

    if (pin.length !== 4) {
        errorEl.textContent = 'PIN harus 4 digit.';
        return;
    }
    if (pin !== confirmPin) {
        errorEl.textContent = 'PIN tidak cocok.';
        return;
    }
    errorEl.textContent = '';

    try {
        const firebaseUser = window.app.firebaseUser;
        let userName = firebaseUser.email.split('@')[0];

        try {
            if (window.app.isOnline) {
                const userDocRef = window.db_firestore.collection('users').doc(firebaseUser.uid);
                const userDoc = await userDocRef.get();
                if (userDoc.exists) {
                    const data = userDoc.data();
                    if (data && data.name) {
                        userName = data.name;
                    }
                }
            }
        } catch (e) {
            console.warn("Could not fetch user profile from Firestore during initial setup (likely offline):", e.message);
        }

        const ownerUser = {
            name: userName,
            pin: pin,
            role: 'owner',
            firebaseUid: firebaseUser.uid,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        const addedId = await putToDB('users', ownerUser);
        window.app.currentUser = { ...ownerUser, id: addedId };

        document.getElementById('setDevicePinModal').classList.add('hidden');
        document.getElementById('appContainer').classList.remove('hidden');
        document.getElementById('bottomNav').classList.remove('hidden');
        window.updateUiForRole();
        window.showPage('dashboard');

    } catch (error) {
        console.error('Failed to set up initial PIN:', error);
        errorEl.textContent = 'Gagal menyimpan PIN. Coba lagi.';
    }
}

export async function handlePinInput(digit) {
    const pinDisplay = document.getElementById('pinDisplay');
    pinDisplay.classList.remove('animate-shake');

    if (digit === 'clear') {
        resetPinInput();
        return;
    }
    if (digit === 'backspace') {
        window.app.currentPinInput = window.app.currentPinInput.slice(0, -1);
    } else if (window.app.currentPinInput.length < 4) {
        window.app.currentPinInput += digit;
    }

    let dots = '';
    for (let i = 0; i < 4; i++) {
        const filled = i < window.app.currentPinInput.length ? 'bg-blue-500 border-blue-500' : 'border-gray-400';
        dots += `<div class="w-4 h-4 rounded-full border-2 ${filled}"></div>`;
    }
    pinDisplay.innerHTML = dots;

    if (window.app.currentPinInput.length === 4) {
        const pin = window.app.currentPinInput;
        const user = await getFromDBByIndex('users', 'pin', pin);

        if (user) {
            localStorage.removeItem('pinFailedAttempts');
            localStorage.removeItem('pinLockoutEndTime');
            localStorage.removeItem('pinLockoutCount');

            window.app.currentUser = user;
            document.getElementById('loginModal').classList.add('hidden');
            document.getElementById('appContainer').classList.remove('hidden');
            document.getElementById('bottomNav').classList.remove('hidden');
            window.updateUiForRole();
            window.showPage('dashboard');
        } else {
            const failedAttempts = parseInt(localStorage.getItem('pinFailedAttempts') || '0') + 1;
            localStorage.setItem('pinFailedAttempts', failedAttempts);

            if (failedAttempts >= FAILED_ATTEMPTS_LIMIT) {
                const lockoutCount = parseInt(localStorage.getItem('pinLockoutCount') || '0') + 1;
                localStorage.setItem('pinLockoutCount', lockoutCount);
                
                let lockoutMinutes = 1;
                if (lockoutCount > 1) lockoutMinutes = 5;
                if (lockoutCount > 2) lockoutMinutes = 15;
                
                const endTime = Date.now() + lockoutMinutes * 60 * 1000;
                localStorage.setItem('pinLockoutEndTime', endTime);
                startPinLockout(endTime);
            } else {
                pinDisplay.classList.add('animate-shake');
                window.showToast(`PIN salah. Sisa percobaan: ${FAILED_ATTEMPTS_LIMIT - failedAttempts}`);
            }
            setTimeout(resetPinInput, 500);
        }
    }
}

export function lockScreen() {
    window.app.currentUser = null;
    document.getElementById('appContainer').classList.add('hidden');
    document.getElementById('bottomNav').classList.add('hidden');
    document.getElementById('loginModal').classList.remove('hidden');
    resetPinInput();
    checkPinLockout();
}

export function checkAccess(allowedRoles) {
    const currentUser = window.app.currentUser;
    if (!currentUser) {
        return false;
    }
    const userRole = currentUser.role;
    if (Array.isArray(allowedRoles)) {
        return allowedRoles.includes(userRole);
    } else {
        return userRole === allowedRoles;
    }
}

export function logout() {
    window.showConfirmationModal('Logout Akun Utama', 'Ini akan mengakhiri sesi Anda. Anda yakin ingin melanjutkan?', () => {
        window.app.currentUser = null;
        if (sessionListenerUnsubscribe) {
            sessionListenerUnsubscribe();
            sessionListenerUnsubscribe = null;
        }
        localStorage.removeItem('active_session_id');
        firebase.auth().signOut(); 
    }, 'Ya, Logout', 'bg-orange-500');
}

export async function showManageUsersModal() {
    document.getElementById('manageUsersModal').classList.remove('hidden');
    await loadUsersForManagement();
}

async function loadUsersForManagement() {
    const listEl = document.getElementById('usersList');
    const users = await getAllFromDB('users');
    const currentUser = window.app.currentUser;

    if (!users.length) {
        listEl.innerHTML = `<p class="text-gray-500 text-center py-4">Tidak ada pengguna.</p>`;
        return;
    }

    listEl.innerHTML = users.sort((a,b) => a.name.localeCompare(b.name)).map(user => {
        const roleDisplay = {
            owner: 'Pemilik',
            manager: 'Manajer',
            cashier: 'Kasir'
        };
        
        let canEdit = false;
        let canDelete = false;

        if (currentUser.role === 'owner') {
            canEdit = true;
            canDelete = user.id !== currentUser.id;
        } else if (currentUser.role === 'manager') {
            canEdit = user.role !== 'owner';
            canDelete = user.role === 'cashier' && user.id !== currentUser.id;
        }

        const editButton = canEdit ? `<button onclick="showUserFormModal(${user.id})" class="text-blue-500 clickable"><i class="fas fa-edit"></i></button>` : `<div class="w-6"></div>`;
        const deleteButton = canDelete ? `<button onclick="deleteUser(${user.id})" class="text-red-500 clickable"><i class="fas fa-trash"></i></button>` : `<div class="w-6"></div>`;

        return `
            <div class="flex justify-between items-center bg-gray-100 p-2 rounded-lg">
                <div>
                    <p class="font-semibold">${user.name}</p>
                    <p class="text-sm text-gray-500">${roleDisplay[user.role]}</p>
                </div>
                <div class="flex items-center gap-4">
                    ${editButton}
                    ${deleteButton}
                </div>
            </div>
        `;
    }).join('');
}

export function closeManageUsersModal() {
    document.getElementById('manageUsersModal').classList.add('hidden');
}

export async function showUserFormModal(userId = null) {
    const modal = document.getElementById('userFormModal');
    const title = document.getElementById('userFormTitle');
    const nameInput = document.getElementById('userName');
    const pinInput = document.getElementById('userPin');
    const roleSelect = document.getElementById('userRole');
    const idInput = document.getElementById('userId');
    const currentUser = window.app.currentUser;

    idInput.value = '';
    nameInput.value = '';
    pinInput.value = '';
    pinInput.placeholder = 'Wajib diisi (4 digit)';
    roleSelect.value = 'cashier';

    Array.from(roleSelect.options).forEach(option => {
        if (currentUser.role === 'manager' && option.value === 'owner') {
            option.disabled = true;
        } else {
            option.disabled = false;
        }
    });

    if (userId) {
        title.textContent = 'Edit Pengguna';
        const user = await getFromDB('users', userId);
        if (user) {
            idInput.value = user.id;
            nameInput.value = user.name;
            roleSelect.value = user.role;
            pinInput.placeholder = 'Kosongkan jika tidak diubah';
            
            if (currentUser.role === 'manager' && user.role === 'owner') {
                 window.showToast('Manajer tidak dapat mengedit data Pemilik.');
                 return;
            }
        }
    } else {
        title.textContent = 'Tambah Pengguna';
    }

    modal.classList.remove('hidden');
}

export function closeUserFormModal() {
    document.getElementById('userFormModal').classList.add('hidden');
}

export async function saveUser() {
    const id = document.getElementById('userId').value ? parseInt(document.getElementById('userId').value) : null;
    const name = document.getElementById('userName').value.trim();
    const pin = document.getElementById('userPin').value.trim();
    const role = document.getElementById('userRole').value;
    const currentUser = window.app.currentUser;

    if (!name) {
        window.showToast('Nama pengguna tidak boleh kosong.');
        return;
    }

    if (!id && pin.length !== 4) {
        window.showToast('PIN baru wajib diisi dan harus 4 digit.');
        return;
    }
    
    if (id && pin && pin.length !== 4) {
        window.showToast('Jika diisi, PIN harus 4 digit.');
        return;
    }
    
    if (pin) {
        const existingUserWithPin = await getFromDBByIndex('users', 'pin', pin);
        if (existingUserWithPin && existingUserWithPin.id !== id) {
            window.showToast('PIN ini sudah digunakan oleh pengguna lain.');
            return;
        }
    }
    
    if (currentUser.role === 'manager' && role === 'owner') {
        window.showToast('Manajer tidak dapat membuat pengguna dengan peran Pemilik.');
        return;
    }

    try {
        let userData;

        if (id) { 
            userData = await getFromDB('users', id);
            if (!userData) {
                window.showToast('Pengguna tidak ditemukan.');
                return;
            }
            userData.name = name;
            userData.role = role;
            if (pin) {
                userData.pin = pin;
            }
            userData.updatedAt = new Date().toISOString();
        } else { 
            userData = {
                name,
                pin,
                role,
                firebaseUid: currentUser.firebaseUid,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
        }

        await putToDB('users', userData);
        
        window.showToast(`Pengguna berhasil ${id ? 'diperbarui' : 'ditambahkan'}.`);
        closeUserFormModal();
        await loadUsersForManagement();
    } catch (error) {
        console.error('Failed to save user:', error);
        window.showToast('Gagal menyimpan pengguna. Cek kembali data Anda.');
    }
}

export function deleteUser(userId) {
    const currentUser = window.app.currentUser;
    if (userId === currentUser.id) {
        window.showToast('Anda tidak dapat menghapus akun Anda sendiri.');
        return;
    }

    window.showConfirmationModal('Hapus Pengguna', 'Yakin ingin menghapus pengguna ini?', async () => {
        try {
            const tx = window.app.db.transaction('users', 'readwrite');
            tx.objectStore('users').delete(userId);
            tx.oncomplete = async () => {
                window.showToast('Pengguna berhasil dihapus.');
                await loadUsersForManagement();
            };
        } catch (error) {
            console.error('Failed to delete user:', error);
            window.showToast('Gagal menghapus pengguna.');
        }
    }, 'Ya, Hapus', 'bg-red-500');
}

export function showAuthContainer(loginMessage = null, messageType = 'error') {
    const authContainer = document.getElementById('authContainer');
    if (authContainer) {
        authContainer.classList.remove('hidden');
        showLoginView(loginMessage, null, messageType); 
    }
}

function switchAuthView(viewToShow) {
    ['loginView', 'forgotPasswordView', 'registerView'].forEach(viewId => {
        const view = document.getElementById(viewId);
        if (view) {
            if (viewId === viewToShow) {
                view.classList.remove('hidden');
            } else {
                view.classList.add('hidden');
            }
        }
    });
    const loginError = document.getElementById('loginError');
    if (loginError) loginError.textContent = '';

    const forgotError = document.getElementById('forgotError');
    if (forgotError) forgotError.textContent = '';
    
    const forgotSuccess = document.getElementById('forgotSuccess');
    if (forgotSuccess) forgotSuccess.textContent = '';

    const registerError = document.getElementById('registerError');
    if (registerError) registerError.textContent = '';
}

export function showLoginView(message = null, email = null, messageType = 'error') {
    switchAuthView('loginView');
    
    const loginError = document.getElementById('loginError');
    const authInfo = document.getElementById('authInfo');

    if (message) {
        if (messageType === 'info' && authInfo) {
            authInfo.textContent = message;
            authInfo.classList.remove('hidden');
        } else if (messageType === 'error' && loginError) {
            if (authInfo) authInfo.classList.add('hidden');
            loginError.textContent = message;
        }
    } else {
        if (authInfo && authInfo.textContent) {
            authInfo.classList.remove('hidden');
        }
    }
    
    const loginEmailInput = document.getElementById('loginEmail');
    if (email && loginEmailInput) {
        loginEmailInput.value = email;
        const loginPasswordInput = document.getElementById('loginPassword');
        if (loginPasswordInput) {
            loginPasswordInput.value = '';
            loginPasswordInput.focus();
        }
    }
}

export function showRegisterView() {
    switchAuthView('registerView');
}

export function showForgotPasswordView() {
    switchAuthView('forgotPasswordView');
}

function setAuthButtonLoading(buttonId, isLoading) {
    const button = document.getElementById(buttonId);
    if (button) {
        button.disabled = isLoading;
        const text = button.querySelector('.auth-button-text');
        const spinner = button.querySelector('.auth-button-spinner');
        if (text) text.style.display = isLoading ? 'none' : 'inline';
        if (spinner) spinner.style.display = isLoading ? 'inline-block' : 'none';
    }
}

export async function handleEmailLogin(event) {
    event.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    setAuthButtonLoading('loginButton', true);

    try {
        const userCredential = await firebase.auth().signInWithEmailAndPassword(email, password);
        
        if (userCredential.user && !userCredential.user.emailVerified) {
            showLoginView('Email Anda belum diverifikasi. Silakan periksa email Anda (termasuk folder spam).', email, 'info');
            await firebase.auth().signOut();
            return;
        }
        
        await claimSession(userCredential.user.uid, userCredential.user.email);

    } catch (error) {
        let errorMessage;
        if (error.code === 'auth/invalid-credential' || error.code === 'auth/invalid-login-credentials' || error.code === 'auth/wrong-password' || error.code === 'auth/user-not-found') {
            console.warn("Login attempt failed (invalid credentials):", error.code);
            errorMessage = 'Email atau password salah.';
        } else {
            console.error("An unexpected login error occurred:", error);
            errorMessage = 'Gagal login. Terjadi kesalahan tak terduga.';
        }
        showLoginView(errorMessage, email, 'error');
    } finally {
        setAuthButtonLoading('loginButton', false);
    }
}

export async function handleGoogleLogin() {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
        await firebase.auth().signInWithPopup(provider);
        // The onAuthStateChanged listener in index.js will handle the rest (session claim, UI update)
    } catch (error) {
        console.error("Google Sign-In Error", error);
        showLoginView("Gagal login dengan Google: " + error.message, null, 'error');
    }
}

export async function handleEmailRegister(event) {
    event.preventDefault();
    const email = document.getElementById('registerEmail').value;
    const password = document.getElementById('registerPassword').value;
    const confirmPassword = document.getElementById('registerConfirmPassword').value;
    const errorEl = document.getElementById('registerError');
    const termsCheckbox = document.getElementById('termsCheckbox');

    setAuthButtonLoading('registerButton', true);
    errorEl.textContent = '';

    if (!email || !password || !confirmPassword) {
        errorEl.textContent = 'Semua kolom wajib diisi.';
        setAuthButtonLoading('registerButton', false);
        return;
    }
    
    if (password.length < 6) {
        errorEl.textContent = 'Password minimal harus 6 karakter.';
        setAuthButtonLoading('registerButton', false);
        return;
    }
    
    if (password !== confirmPassword) {
        errorEl.textContent = 'Konfirmasi password tidak cocok.';
        setAuthButtonLoading('registerButton', false);
        return;
    }

    if (!termsCheckbox.checked) {
        errorEl.textContent = 'Anda harus menyetujui pendaftaran.';
        setAuthButtonLoading('registerButton', false);
        return;
    }

    if (!email.toLowerCase().endsWith('@gmail.com')) {
        errorEl.textContent = 'Pendaftaran hanya bisa menggunakan email @gmail.com';
        setAuthButtonLoading('registerButton', false);
        return;
    }

    try {
        const signInMethods = await firebase.auth().fetchSignInMethodsForEmail(email);

        if (signInMethods.length > 0) {
            const message = 'Email ini sudah terdaftar. Jika belum terverifikasi, silakan cek email Anda (termasuk folder spam).';
            showLoginView(message, email, 'info');
            return;
        }

        const userCredential = await firebase.auth().createUserWithEmailAndPassword(email, password);
        
        if (userCredential.user) {
            try {
                await userCredential.user.sendEmailVerification();
                
                await firebase.auth().signOut();

                const successMessage = 'Pendaftaran berhasil! Email verifikasi telah dikirim. Silakan periksa kotak masuk/spam Anda, lalu login.';
                showLoginView(successMessage, email, 'info');

            } catch (verificationError) {
                console.error("Failed to send verification email. Rolling back user creation.", verificationError);
                await userCredential.user.delete();
                errorEl.textContent = 'Gagal mengirim email verifikasi. Coba lagi.';
            }
        }
    } catch (error) {
        console.error("Registration process error:", error.code, error.message);
        if (error.code === 'auth/email-already-in-use') {
            const message = 'Email ini sudah terdaftar. Jika belum terverifikasi, silakan cek email Anda (termasuk folder spam).';
            showLoginView(message, email, 'info');
        } else if (error.code === 'auth/weak-password') {
            errorEl.textContent = 'Password terlalu lemah.';
        } else {
            errorEl.textContent = 'Gagal mendaftar. Terjadi kesalahan jaringan atau server.';
        }
    } finally {
        setAuthButtonLoading('registerButton', false);
    }
}


export async function handleForgotPassword(event) {
    event.preventDefault();
    const email = document.getElementById('forgotEmail').value;
    const errorEl = document.getElementById('forgotError');
    const successEl = document.getElementById('forgotSuccess');
    setAuthButtonLoading('forgotButton', true);
    errorEl.textContent = '';
    successEl.textContent = '';

    try {
        await firebase.auth().sendPasswordResetEmail(email);
        successEl.textContent = 'Link reset password telah dikirim ke email Anda.';
    } catch (error) {
        console.error("Forgot password failed:", error.code);
        errorEl.textContent = 'Gagal mengirim link. Periksa kembali email Anda.';
    } finally {
        setAuthButtonLoading('forgotButton', false);
    }
}

export function togglePasswordVisibility(inputId, iconId) {
    const passwordInput = document.getElementById(inputId);
    const passwordIcon = document.getElementById(iconId);

    if (passwordInput && passwordIcon) {
        if (passwordInput.type === 'password') {
            passwordInput.type = 'text';
            passwordIcon.classList.remove('fa-eye');
            passwordIcon.classList.add('fa-eye-slash');
        } else {
            passwordInput.type = 'password';
            passwordIcon.classList.remove('fa-eye-slash');
            passwordIcon.classList.add('fa-eye');
        }
    }
}

let countdownInterval = null;

export function startCountdown() {
    if (countdownInterval) {
        return;
    }

    const timerDisplay = document.getElementById('timerDisplay');
    const featureLinkContainer = document.getElementById('featureLinkContainer');

    let countdownEndTime = localStorage.getItem('countdownEndTime');

    if (!countdownEndTime) {
        const initialDurationMs = 30 * 24 * 60 * 60 * 1000;
        countdownEndTime = Date.now() + initialDurationMs;
        localStorage.setItem('countdownEndTime', countdownEndTime);
    }

    const updateView = () => {
        const remainingTime = parseInt(countdownEndTime) - Date.now();

        if (remainingTime <= 0) {
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            if (timerDisplay) timerDisplay.classList.add('hidden');
            if (featureLinkContainer) featureLinkContainer.classList.remove('hidden');
        } else {
            if (timerDisplay) timerDisplay.classList.remove('hidden');
            if (featureLinkContainer) featureLinkContainer.classList.add('hidden');
            
            const days = Math.floor(remainingTime / (1000 * 60 * 60 * 24));
            const hours = Math.floor((remainingTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((remainingTime % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((remainingTime % (1000 * 60)) / 1000);

            const daysEl = document.getElementById('timer-days');
            const hoursEl = document.getElementById('timer-hours');
            const minutesEl = document.getElementById('timer-minutes');
            const secondsEl = document.getElementById('timer-seconds');
            
            if (daysEl) daysEl.textContent = days.toString();
            if (hoursEl) hoursEl.textContent = hours.toString().padStart(2, '0');
            if (minutesEl) minutesEl.textContent = minutes.toString().padStart(2, '0');
            if (secondsEl) secondsEl.textContent = seconds.toString().padStart(2, '0');
        }
    };
    
    updateView();
    
    if (parseInt(countdownEndTime) - Date.now() > 0) {
        countdownInterval = setInterval(updateView, 1000);
    }
}

export function extendProAccess() {
    window.showConfirmationModal(
        'Aktifkan Akses PRO',
        'Masa aktif akun TRIAL akan segera berakhir. langkah selanjutnya diperlukan Registrasi untuk melanjutkan Akses akun anda. Apakah Anda yakin ingin melanjutkan Akses PRO?',
        () => {
            const durationMs = 60 * 1000; 
            const newEndTime = Date.now() + durationMs;
            localStorage.setItem('countdownEndTime', newEndTime);

            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            
            startCountdown();
            window.showToast('Akses PRO berhasil diaktifkan (60 Detik).');
        },
        'Aktifkan',
        'bg-purple-600'
    );
}

