


import { getAllFromDB, getFromDB, putToDB, getAllProductsLite, getFromDBByIndex } from "./db.js";
import { showToast, showConfirmationModal, formatCurrency } from "./ui.js";
import { queueSyncAction } from "./sync.js";

// --- FILTERS STATE ---
let isLowStockFilterActive = false;
let isExpiringFilterActive = false;

export function setLowStockFilter(active) {
    isLowStockFilterActive = active;
    updateLowStockFilterUI();
}

export function setExpiringFilter(active) {
    isExpiringFilterActive = active;
    updateExpiringFilterUI();
}

export function toggleLowStockFilter() {
    isLowStockFilterActive = !isLowStockFilterActive;
    updateLowStockFilterUI();
    loadProductsList(true, true);
}

export function toggleExpiringFilter() {
    isExpiringFilterActive = !isExpiringFilterActive;
    updateExpiringFilterUI();
    loadProductsList(true, true);
}

function updateLowStockFilterUI() {
    const btn = document.getElementById('filterLowStockBtn');
    if (!btn) return;
    
    const thresholdSpan = document.getElementById('lowStockThresholdDisplay');
    if (thresholdSpan) thresholdSpan.textContent = window.app.lowStockThreshold;

    if (isLowStockFilterActive) {
        btn.classList.remove('bg-gray-200', 'text-gray-700');
        btn.classList.add('bg-yellow-100', 'text-yellow-700', 'border', 'border-yellow-300');
    } else {
        btn.classList.add('bg-gray-200', 'text-gray-700');
        btn.classList.remove('bg-yellow-100', 'text-yellow-700', 'border', 'border-yellow-300');
    }
}

function updateExpiringFilterUI() {
    const btn = document.getElementById('filterExpiringBtn');
    if (!btn) return;

    if (isExpiringFilterActive) {
        btn.classList.remove('bg-gray-200', 'text-gray-700');
        btn.classList.add('bg-red-100', 'text-red-700', 'border', 'border-red-300');
    } else {
        btn.classList.add('bg-gray-200', 'text-gray-700');
        btn.classList.remove('bg-red-100', 'text-red-700', 'border', 'border-red-300');
    }
}

// --- SANITIZATION HELPERS ---
function sanitizeProduct(product) {
    if (!product) return null;
    return {
        id: product.id,
        serverId: product.serverId,
        name: product.name,
        price: product.price,
        purchasePrice: product.purchasePrice,
        stock: product.stock,
        barcode: product.barcode,
        category: product.category,
        discount: product.discount,
        image: product.image,
        batchNumber: product.batchNumber,
        expiryDate: product.expiryDate,
        supplierInfo: product.supplierInfo,
        notes: product.notes,
        wholesalePrices: product.wholesalePrices || [],
        variations: product.variations || [],
        createdAt: product.createdAt,
        updatedAt: product.updatedAt
    };
}

function sanitizeCategory(category) {
    if (!category) return null;
    return {
        id: category.id,
        serverId: category.serverId,
        name: category.name,
        createdAt: category.createdAt,
        updatedAt: category.updatedAt
    };
}

// --- STOCK LOGGING HELPER ---
export async function logStockChange({productId, productName, variationName, oldStock, newStock, type, reason, userId, userName}) {
    if (oldStock === null || newStock === null) return; 
    const changeAmount = newStock - oldStock;
    if (changeAmount === 0) return;

    const logEntry = {
        productId,
        productName,
        variationName: variationName || null,
        oldStock,
        newStock,
        changeAmount,
        type, 
        reason,
        userId: userId || (window.app.currentUser ? window.app.currentUser.id : null),
        userName: userName || (window.app.currentUser ? window.app.currentUser.name : 'System'),
        date: new Date().toISOString()
    };

    try {
        await putToDB('stock_history', logEntry);
        await queueSyncAction('CREATE_STOCK_LOG', logEntry);
    } catch (e) {
        console.error("Failed to log stock change", e);
    }
}

// --- MODAL & FORM FUNCTIONS ---

// NEW: Toggle Advanced Fields
export function toggleAdvancedRetailFields(mode) {
    const toggleId = mode === 'add' ? 'addAdvancedToggle' : 'editAdvancedToggle';
    const fieldsId = mode === 'add' ? 'addAdvancedFields' : 'editAdvancedFields';
    
    const toggle = document.getElementById(toggleId);
    const fields = document.getElementById(fieldsId);
    
    if (toggle && fields) {
        if (toggle.checked) {
            fields.classList.remove('hidden');
        } else {
            fields.classList.add('hidden');
        }
    }
}

export function showAddProductModal() {
    document.getElementById('addProductModal').classList.remove('hidden');
    // Reset form
    document.getElementById('productImage').value = '';
    document.getElementById('imagePreview').innerHTML = `
        <i class="fas fa-camera text-3xl mb-2"></i>
        <p>Tap untuk upload gambar</p>
    `;
    window.app.currentImageData = null;
    document.getElementById('productName').value = '';
    document.getElementById('productBarcode').value = '';
    document.getElementById('productPrice').value = '';
    document.getElementById('productPurchasePrice').value = '';
    document.getElementById('productStock').value = '';
    document.getElementById('productCategory').selectedIndex = 0;
    document.getElementById('productDiscountValue').value = '';
    document.getElementById('variationsContainer').innerHTML = '';
    document.getElementById('wholesalePricesContainer').innerHTML = '';
    document.getElementById('unlimitedStock').checked = false;
    
    document.getElementById('productBatchNumber').value = '';
    document.getElementById('productExpiryDate').value = '';
    document.getElementById('productSupplierInfo').value = '';
    document.getElementById('productNotes').value = '';
    
    // Reset advanced toggle
    const advToggle = document.getElementById('addAdvancedToggle');
    if (advToggle) {
        advToggle.checked = false;
        toggleAdvancedRetailFields('add');
    }

    updateMainFieldsState('addProductModal');
}

export function closeAddProductModal() {
    document.getElementById('addProductModal').classList.add('hidden');
}

export function previewImage(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            window.app.currentImageData = e.target.result;
            document.getElementById('imagePreview').innerHTML = `<img src="${e.target.result}" class="image-preview">`;
        }
        reader.readAsDataURL(file);
    }
}

// --- PRODUCT CRUD ---

export async function addProduct() {
    const name = document.getElementById('productName').value;
    const barcode = document.getElementById('productBarcode').value;
    const category = document.getElementById('productCategory').value;
    
    const price = parseFloat(document.getElementById('productPrice').value) || 0;
    const purchasePrice = parseFloat(document.getElementById('productPurchasePrice').value) || 0;
    const stockInput = document.getElementById('productStock');
    const isUnlimited = document.getElementById('unlimitedStock').checked;
    const stock = isUnlimited ? null : (parseInt(stockInput.value) || 0);
    
    const discountValue = parseFloat(document.getElementById('productDiscountValue').value) || 0;

    // Get Variations
    const variations = [];
    document.querySelectorAll('#variationsContainer .variation-row').forEach(row => {
        const vName = row.querySelector('.name').value;
        const vPurchase = parseFloat(row.querySelector('.purchasePrice').value) || 0;
        const vPrice = parseFloat(row.querySelector('.price').value) || 0;
        const vStockVal = row.querySelector('.stock').value;
        const vStock = (vStockVal === '' || isUnlimited) ? null : (parseInt(vStockVal) || 0);
        
        const vWholesale = [];
        row.querySelectorAll('.wholesale-price-row').forEach(wRow => {
             vWholesale.push({
                min: parseInt(wRow.querySelector('.min-qty').value) || 0,
                max: parseInt(wRow.querySelector('.max-qty').value) || null,
                price: parseFloat(wRow.querySelector('.price').value) || 0
            });
        });

        if (vName) {
            variations.push({ 
                name: vName, 
                purchasePrice: vPurchase, 
                price: vPrice, 
                stock: vStock,
                wholesalePrices: vWholesale
            });
        }
    });

    // Get Wholesale Prices (Main)
    const wholesalePrices = [];
    document.querySelectorAll('#wholesalePricesContainer .wholesale-price-row').forEach(row => {
        wholesalePrices.push({
            min: parseInt(row.querySelector('.min-qty').value) || 0,
            max: parseInt(row.querySelector('.max-qty').value) || null,
            price: parseFloat(row.querySelector('.price').value) || 0
        });
    });

    if (!name) {
        showToast('Nama produk wajib diisi');
        return;
    }

    if (barcode) {
        const existing = await getFromDBByIndex('products', 'barcode', barcode);
        if (existing) {
             showToast('Barcode sudah digunakan produk lain.');
             return;
        }
    }

    const newProduct = {
        name,
        price,
        purchasePrice,
        stock,
        barcode,
        category,
        discount: { type: 'fixed', value: discountValue },
        image: window.app.currentImageData,
        variations,
        wholesalePrices,
        batchNumber: document.getElementById('productBatchNumber').value,
        expiryDate: document.getElementById('productExpiryDate').value,
        supplierInfo: document.getElementById('productSupplierInfo').value,
        notes: document.getElementById('productNotes').value,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    try {
        const id = await putToDB('products', newProduct);
        await queueSyncAction('CREATE_PRODUCT', { ...newProduct, id });
        
        await logStockChange({
            productId: id,
            productName: name,
            oldStock: 0,
            newStock: stock === null ? 0 : stock,
            type: 'Initial',
            reason: 'Produk Baru'
        });

        showToast('Produk berhasil ditambahkan');
        closeAddProductModal();
        loadProductsList();
    } catch (error) {
        console.error('Error adding product:', error);
        showToast('Gagal menambahkan produk');
    }
}

export async function editProduct(id) {
    try {
        const product = await getFromDB('products', id);
        if (!product) return;

        document.getElementById('editProductId').value = product.id;
        document.getElementById('editProductName').value = product.name;
        document.getElementById('editProductBarcode').value = product.barcode || '';
        document.getElementById('editProductPrice').value = product.price;
        document.getElementById('editProductPurchasePrice').value = product.purchasePrice || 0;
        
        const stockInput = document.getElementById('editProductStock');
        const unlimitedCheckbox = document.getElementById('editUnlimitedStock');
        
        if (product.stock === null) {
             unlimitedCheckbox.checked = true;
             stockInput.value = '';
        } else {
             unlimitedCheckbox.checked = false;
             stockInput.value = product.stock;
        }
        
        document.getElementById('editProductCategory').value = product.category;
        
        let discountVal = 0;
        if (product.discount) {
            discountVal = product.discount.value;
        } else if (product.discountPercentage) {
            discountVal = product.discountPercentage;
        }
        document.getElementById('editProductDiscountValue').value = discountVal || '';

        window.app.currentEditImageData = product.image;
        const previewEl = document.getElementById('editImagePreview');
        if (product.image) {
            previewEl.innerHTML = `<img src="${product.image}" class="image-preview">`;
        } else {
             previewEl.innerHTML = `
                <i class="fas fa-camera text-3xl mb-2"></i>
                <p>Tap untuk ubah gambar</p>
            `;
        }

        const varContainer = document.getElementById('editVariationsContainer');
        varContainer.innerHTML = '';
        if (product.variations) {
            product.variations.forEach(v => {
                addVariationRow('editProductModal', v);
            });
        }

        const wsContainer = document.getElementById('editWholesalePricesContainer');
        wsContainer.innerHTML = '';
        if (product.wholesalePrices) {
            product.wholesalePrices.forEach(wp => {
                addWholesalePriceRow('editProductModal', wp);
            });
        }
        
        document.getElementById('editProductBatchNumber').value = product.batchNumber || '';
        document.getElementById('editProductExpiryDate').value = product.expiryDate || '';
        document.getElementById('editProductSupplierInfo').value = product.supplierInfo || '';
        document.getElementById('editProductNotes').value = product.notes || '';
        
        // Auto-enable Advanced Toggle if fields are populated
        const hasVariations = product.variations && product.variations.length > 0;
        const hasWholesale = product.wholesalePrices && product.wholesalePrices.length > 0;
        const hasDiscount = discountVal > 0;
        const hasBatchInfo = product.batchNumber || product.expiryDate || product.supplierInfo || product.notes;
        
        const isAdvanced = hasVariations || hasWholesale || hasDiscount || hasBatchInfo;
        const advToggle = document.getElementById('editAdvancedToggle');
        if (advToggle) {
            advToggle.checked = isAdvanced;
            toggleAdvancedRetailFields('edit');
        }

        updateMainFieldsState('editProductModal');
        document.getElementById('editProductModal').classList.remove('hidden');

    } catch (error) {
        console.error("Error editing product:", error);
        showToast("Gagal memuat produk.");
    }
}

export function closeEditProductModal() {
    document.getElementById('editProductModal').classList.add('hidden');
}

export function previewEditImage(event) {
    const file = event.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(e) {
            window.app.currentEditImageData = e.target.result;
            document.getElementById('editImagePreview').innerHTML = `<img src="${e.target.result}" class="image-preview">`;
        }
        reader.readAsDataURL(file);
    }
}

export async function updateProduct() {
    const id = parseInt(document.getElementById('editProductId').value);
    const name = document.getElementById('editProductName').value;
    const barcode = document.getElementById('editProductBarcode').value;
    const category = document.getElementById('editProductCategory').value;
    
    const price = parseFloat(document.getElementById('editProductPrice').value) || 0;
    const purchasePrice = parseFloat(document.getElementById('editProductPurchasePrice').value) || 0;
    
    const isUnlimited = document.getElementById('editUnlimitedStock').checked;
    const stock = isUnlimited ? null : (parseInt(document.getElementById('editProductStock').value) || 0);

    const discountValue = parseFloat(document.getElementById('editProductDiscountValue').value) || 0;

    const variations = [];
    document.querySelectorAll('#editVariationsContainer .variation-row').forEach(row => {
        const vName = row.querySelector('.name').value;
        const vPurchase = parseFloat(row.querySelector('.purchasePrice').value) || 0;
        const vPrice = parseFloat(row.querySelector('.price').value) || 0;
        const vStockVal = row.querySelector('.stock').value;
        const vStock = (vStockVal === '' || isUnlimited) ? null : (parseInt(vStockVal) || 0);

        const vWholesale = [];
        row.querySelectorAll('.wholesale-price-row').forEach(wRow => {
             vWholesale.push({
                min: parseInt(wRow.querySelector('.min-qty').value) || 0,
                max: parseInt(wRow.querySelector('.max-qty').value) || null,
                price: parseFloat(wRow.querySelector('.price').value) || 0
            });
        });

        if (vName) {
            variations.push({ 
                name: vName, 
                purchasePrice: vPurchase, 
                price: vPrice, 
                stock: vStock,
                wholesalePrices: vWholesale
            });
        }
    });

    const wholesalePrices = [];
    document.querySelectorAll('#editWholesalePricesContainer .wholesale-price-row').forEach(row => {
        wholesalePrices.push({
            min: parseInt(row.querySelector('.min-qty').value) || 0,
            max: parseInt(row.querySelector('.max-qty').value) || null,
            price: parseFloat(row.querySelector('.price').value) || 0
        });
    });

    try {
        const oldProduct = await getFromDB('products', id);
        
        if (oldProduct.stock !== stock && stock !== null && oldProduct.stock !== null) {
             await logStockChange({
                productId: id,
                productName: name,
                oldStock: oldProduct.stock,
                newStock: stock,
                type: 'Adjustment',
                reason: 'Edit Manual'
            });
        }

        const updatedProduct = {
            ...oldProduct,
            name,
            price,
            purchasePrice,
            stock,
            barcode,
            category,
            discount: { type: 'fixed', value: discountValue },
            image: window.app.currentEditImageData,
            variations,
            wholesalePrices,
            batchNumber: document.getElementById('editProductBatchNumber').value,
            expiryDate: document.getElementById('editProductExpiryDate').value,
            supplierInfo: document.getElementById('editProductSupplierInfo').value,
            notes: document.getElementById('editProductNotes').value,
            updatedAt: new Date().toISOString()
        };

        await putToDB('products', updatedProduct);
        await queueSyncAction('UPDATE_PRODUCT', updatedProduct);

        showToast('Produk diperbarui');
        closeEditProductModal();
        loadProductsList();
    } catch (error) {
        console.error('Error updating product:', error);
        showToast('Gagal memperbarui produk');
    }
}

export async function deleteProduct(id) {
    showConfirmationModal('Hapus Produk', 'Apakah Anda yakin ingin menghapus produk ini?', async () => {
        try {
            const productToDelete = await getFromDB('products', id);
            const transaction = window.app.db.transaction(['products'], 'readwrite');
            const store = transaction.objectStore('products');
            store.delete(id);
            
            transaction.oncomplete = async () => {
                await queueSyncAction('DELETE_PRODUCT', sanitizeProduct(productToDelete));
                showToast('Produk dihapus');
                loadProductsList();
            };
        } catch (error) {
            console.error("Delete product error:", error);
            showToast('Gagal menghapus produk');
        }
    }, 'Ya, Hapus', 'bg-red-500');
}

export async function increaseStock(id) {
    await updateStock(id, 1);
}

export async function decreaseStock(id) {
    await updateStock(id, -1);
}

async function updateStock(id, change) {
    try {
        const product = await getFromDB('products', id);
        if (product && product.stock !== null) {
            const oldStock = product.stock;
            const newStock = Math.max(0, product.stock + change);
            
            product.stock = newStock;
            product.updatedAt = new Date().toISOString();
            
            await putToDB('products', product);
            
            await logStockChange({
                productId: product.id,
                productName: product.name,
                oldStock: oldStock,
                newStock: newStock,
                type: 'Adjustment',
                reason: 'Tombol Cepat'
            });

            await queueSyncAction('UPDATE_PRODUCT', sanitizeProduct(product));

            const display = document.getElementById(`stock-display-${id}`);
            if (display) display.textContent = newStock;
            
            if (isLowStockFilterActive) {
                loadProductsList();
            }
        }
    } catch (error) {
        console.error('Stock update failed:', error);
    }
}

// --- DYNAMIC FORM ROWS ---

let wholesalePriceRowId = 0;
export function addWholesalePriceRow(modalType, data = { min: '', max: '', price: '' }) {
    const containerId = modalType === 'addProductModal' ? 'wholesalePricesContainer' : 'editWholesalePricesContainer';
    const container = document.getElementById(containerId);
    if (!container) return;

    const rowId = `wholesale-row-${wholesalePriceRowId++}`;
    const row = document.createElement('div');
    row.id = rowId;
    row.className = 'wholesale-price-row bg-gray-50 p-3 rounded-lg border relative';
    row.innerHTML = `
        <div class="grid grid-cols-2 gap-2 mb-2">
            <input type="number" class="input-field min-qty" placeholder="Qty Min" value="${data.min || ''}">
            <input type="number" class="input-field max-qty" placeholder="Qty Max" value="${data.max || ''}">
        </div>
        <div class="grid grid-cols-1">
            <input type="number" class="input-field price" placeholder="Harga Grosir" value="${data.price || ''}">
        </div>
        <button type="button" onclick="document.getElementById('${rowId}').remove()" class="absolute top-1 right-1 text-red-500 hover:text-red-700 clickable p-2"><i class="fas fa-times-circle"></i></button>
    `;
    container.appendChild(row);
}


let variationRowId = 0;
let variationWholesalePriceRowId = 0;
export function addVariationWholesalePriceRow(variationRowId, data = { min: '', max: '', price: '' }) {
    const container = document.getElementById(`wholesale-container-${variationRowId}`);
    if (!container) return;

    const rowId = `variation-wholesale-row-${variationWholesalePriceRowId++}`;
    const row = document.createElement('div');
    row.id = rowId;
    row.className = 'wholesale-price-row bg-gray-50 p-3 rounded-lg border relative';
    row.innerHTML = `
        <div class="grid grid-cols-2 gap-2 mb-2">
            <input type="number" class="input-field min-qty" placeholder="Qty Min" value="${data.min || ''}">
            <input type="number" class="input-field max-qty" placeholder="Qty Max" value="${data.max || ''}">
        </div>
        <div class="grid grid-cols-1">
            <input type="number" class="input-field price" placeholder="Harga Grosir" value="${data.price || ''}">
        </div>
        <button type="button" onclick="document.getElementById('${rowId}').remove()" class="absolute top-1 right-1 text-red-500 hover:text-red-700 clickable p-2"><i class="fas fa-times-circle"></i></button>
    `;
    container.appendChild(row);
}

export function addVariationRow(modalType, data = { name: '', purchasePrice: '', price: '', stock: '', wholesalePrices: [] }) {
    const containerId = modalType === 'addProductModal' ? 'variationsContainer' : 'editVariationsContainer';
    const container = document.getElementById(containerId);
    if (!container) return;

    const isAddModal = modalType === 'addProductModal';
    const unlimitedCheckbox = document.getElementById(isAddModal ? 'unlimitedStock' : 'editUnlimitedStock');
    const isUnlimited = unlimitedCheckbox ? unlimitedCheckbox.checked : false;

    const stockValue = isUnlimited ? '' : (data.stock !== null ? (data.stock || '') : '');
    const stockPlaceholder = isUnlimited ? '∞' : 'Stok';
    const stockDisabled = isUnlimited ? 'disabled' : '';

    const rowId = `variation-row-${variationRowId++}`;
    const row = document.createElement('div');
    row.id = rowId;
    row.className = 'variation-row p-3 bg-white rounded-lg border space-y-2';
    row.innerHTML = `
        <div class="flex items-center justify-between gap-2">
            <input type="text" class="input-field flex-grow name" placeholder="Nama (e.g. Merah)" value="${data.name || ''}">
            <button type="button" onclick="document.getElementById('${rowId}').remove(); updateMainFieldsState('${modalType}'); updateTotalStock('${modalType}');" class="text-red-500 clickable p-2"><i class="fas fa-times-circle"></i></button>
        </div>
        <div class="grid grid-cols-2 gap-2">
            <input type="number" class="input-field purchasePrice" placeholder="Harga Beli" value="${data.purchasePrice || ''}">
            <input type="number" class="input-field price" placeholder="Harga Jual" value="${data.price || ''}">
        </div>
        <div class="grid grid-cols-1">
            <input type="number" class="input-field stock" placeholder="${stockPlaceholder}" value="${stockValue}" oninput="updateTotalStock('${modalType}')" ${stockDisabled}>
        </div>
        <div id="wholesale-container-${rowId}" class="mt-2 space-y-2">
        </div>
        <button type="button" onclick="addVariationWholesalePriceRow('${rowId}')" class="text-xs text-blue-600 hover:underline mt-1">
            + Tambah Harga Grosir
        </button>
    `;
    container.appendChild(row);

    if (data.wholesalePrices && Array.isArray(data.wholesalePrices)) {
        data.wholesalePrices.forEach(wp => {
            addVariationWholesalePriceRow(rowId, wp);
        });
    }

    updateMainFieldsState(modalType);
}

export function updateMainFieldsState(modalType) {
    const isAddModal = modalType === 'addProductModal';
    const variationsContainer = document.getElementById(isAddModal ? 'variationsContainer' : 'editVariationsContainer');
    const priceInput = document.getElementById(isAddModal ? 'productPrice' : 'editProductPrice');
    const purchasePriceInput = document.getElementById(isAddModal ? 'productPurchasePrice' : 'editProductPurchasePrice');
    const stockInput = document.getElementById(isAddModal ? 'productStock' : 'editProductStock');
    const mainWholesaleSection = document.getElementById(isAddModal ? 'mainWholesalePriceSection' : 'editMainWholesalePriceSection');
    
    const hasVariations = variationsContainer.querySelector('.variation-row') !== null;

    if (priceInput && stockInput && purchasePriceInput) {
        priceInput.disabled = hasVariations;
        purchasePriceInput.disabled = hasVariations;
        stockInput.readOnly = hasVariations;
        
        if (hasVariations) {
            priceInput.value = '';
            priceInput.placeholder = 'Diatur per variasi';
            purchasePriceInput.value = '';
            purchasePriceInput.placeholder = 'Diatur per variasi';
            stockInput.classList.add('bg-gray-100');
            if(mainWholesaleSection) mainWholesaleSection.style.display = 'none';
            updateTotalStock(modalType);
        } else {
            priceInput.placeholder = '0';
            purchasePriceInput.placeholder = '0';
            stockInput.classList.remove('bg-gray-100');
            if(mainWholesaleSection) mainWholesaleSection.style.display = 'block';
        }
    }
}

export function updateTotalStock(modalType) {
    const isAddModal = modalType === 'addProductModal';
    const variationsContainer = document.getElementById(isAddModal ? 'variationsContainer' : 'editVariationsContainer');
    const stockInput = document.getElementById(isAddModal ? 'productStock' : 'editProductStock');
    const hasVariations = variationsContainer.querySelector('.variation-row') !== null;
    
    if (!stockInput || !hasVariations) return;

    let totalStock = 0;
    variationsContainer.querySelectorAll('.variation-row .stock').forEach(stockEl => {
        totalStock += parseInt(stockEl.value) || 0;
    });
    stockInput.value = totalStock;
}

export function toggleUnlimitedStock(modalType) {
    const isAddModal = modalType === 'addProductModal';
    const stockInput = document.getElementById(isAddModal ? 'productStock' : 'editProductStock');
    const unlimitedCheckbox = document.getElementById(isAddModal ? 'unlimitedStock' : 'editUnlimitedStock');
    const variationsContainer = document.getElementById(isAddModal ? 'variationsContainer' : 'editVariationsContainer');

    if (stockInput && unlimitedCheckbox) {
        const isUnlimited = unlimitedCheckbox.checked;

        const hasVariations = variationsContainer && variationsContainer.querySelector('.variation-row') !== null;
        stockInput.disabled = isUnlimited || hasVariations;
        stockInput.readOnly = hasVariations && !isUnlimited;

        stockInput.placeholder = isUnlimited ? '∞' : (hasVariations ? 'Diatur per variasi' : '0');
        if (isUnlimited) {
            stockInput.value = '';
        }

        if (variationsContainer) {
            variationsContainer.querySelectorAll('.variation-row .stock').forEach(input => {
                input.disabled = isUnlimited;
                input.placeholder = isUnlimited ? '∞' : 'Stok';
                if (isUnlimited) {
                    input.value = '';
                }
            });
        }
        
        updateTotalStock(modalType);
    }
}


// --- CATEGORY MANAGEMENT ---
export async function populateCategoryDropdowns(selectElementIds, selectedValue) {
    try {
        const categories = await getAllFromDB('categories');
        categories.sort((a, b) => a.name.localeCompare(b.name));

        selectElementIds.forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;

            const isFilter = id === 'productCategoryFilter';
            
            const currentValue = isFilter ? select.value : selectedValue;
            select.innerHTML = '';

            if (isFilter) {
                const allOption = document.createElement('option');
                allOption.value = 'all';
                allOption.textContent = 'Semua Kategori';
                select.appendChild(allOption);
            } else {
                 const placeholder = document.createElement('option');
                 placeholder.value = '';
                 placeholder.textContent = 'Pilih Kategori...';
                 placeholder.disabled = true;
                 select.appendChild(placeholder);
            }

            categories.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.name;
                option.textContent = cat.name;
                select.appendChild(option);
            });
            
            if (currentValue && select.querySelector(`option[value="${currentValue}"]`)) {
                select.value = currentValue;
            } else if (!isFilter) {
                select.selectedIndex = 0;
            }
        });
    } catch (error) {
        console.error("Failed to populate categories:", error);
    }
}

export async function showManageCategoryModal() {
    (document.getElementById('manageCategoryModal')).classList.remove('hidden');
    await loadCategoriesForManagement();
}

export function closeManageCategoryModal() {
    (document.getElementById('manageCategoryModal')).classList.add('hidden');
    (document.getElementById('newCategoryName')).value = '';
}

async function loadCategoriesForManagement() {
    const listEl = document.getElementById('categoryList');
    const categories = await getAllFromDB('categories');
    categories.sort((a, b) => a.name.localeCompare(b.name));

    if (categories.length === 0) {
        listEl.innerHTML = `<p class="text-gray-500 text-center py-4">Belum ada kategori</p>`;
        return;
    }
    listEl.innerHTML = categories.map(cat => `
        <div class="flex justify-between items-center bg-gray-100 p-2 rounded-lg">
            <span>${cat.name}</span>
            <button onclick="deleteCategory(${cat.id}, '${cat.name}')" class="text-red-500 clickable"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
}

export async function addNewCategory() {
    const input = document.getElementById('newCategoryName');
    const name = input.value.trim();
    if (!name) {
        window.showToast('Nama kategori tidak boleh kosong');
        return;
    }

    try {
        const existingCategories = await getAllFromDB('categories');
        const isDuplicate = existingCategories.some(c => c.name.toLowerCase() === name.toLowerCase());
        
        if (isDuplicate) {
            window.showToast('Kategori sudah ada.');
            return;
        }

        const newCategory = { name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        const addedId = await putToDB('categories', newCategory);
        
        await queueSyncAction('CREATE_CATEGORY', { ...newCategory, id: addedId });
        window.showToast('Kategori berhasil ditambahkan');
        input.value = '';
        await loadCategoriesForManagement();
        await populateCategoryDropdowns(['productCategory', 'editProductCategory', 'productCategoryFilter']);
    } catch (error) {
        window.showToast('Gagal menambahkan kategori.');
        console.error("Add category error:", error);
    }
}

export async function deleteCategory(id, name) {
    const products = await getAllFromDB('products');
    const isUsed = products.some(p => p.category === name);

    if (isUsed) {
        window.showToast(`Kategori "${name}" tidak dapat dihapus karena sedang digunakan oleh produk.`);
        return;
    }

    closeManageCategoryModal();

    window.showConfirmationModal(
        'Hapus Kategori',
        `Apakah Anda yakin ingin menghapus kategori "${name}"?`,
        async () => {
            const categoryToDelete = await getFromDB('categories', id);
            const transaction = window.app.db.transaction(['categories'], 'readwrite');
            const store = transaction.objectStore('categories');
            store.delete(id);
            transaction.oncomplete = async () => {
                await queueSyncAction('DELETE_CATEGORY', sanitizeCategory(categoryToDelete));
                window.showToast('Kategori berhasil dihapus');
                await populateCategoryDropdowns(['productCategory', 'editProductCategory', 'productCategoryFilter']);
            };
        },
        'Ya, Hapus',
        'bg-red-500'
    );
}

// --- PRODUCT MANAGEMENT ---

async function loadVisibleImages() {
    const lazyImages = document.querySelectorAll('img[data-lazy-id]');
    
    for (const img of lazyImages) {
        const id = parseInt(img.dataset.lazyId);
        try {
            const product = await getFromDB('products', id);
            if (product && product.image) {
                img.src = product.image;
                img.onload = () => {
                    img.classList.remove('opacity-50', 'bg-gray-200');
                };
                img.removeAttribute('data-lazy-id');
            } else {
                const container = document.createElement('div');
                container.className = "bg-gray-100 rounded-lg p-4 mb-2 flex items-center justify-center";
                if(img.classList.contains('product-list-image')) {
                    container.style.width = '60px';
                    container.style.height = '60px';
                    container.innerHTML = '<i class="fas fa-box text-2xl text-gray-400"></i>';
                } else {
                    container.innerHTML = '<i class="fas fa-box text-3xl text-gray-400"></i>';
                }
                img.replaceWith(container);
            }
        } catch (e) {
            console.warn('Failed to load image for', id);
        }
    }
}

function renderProductGridItem(p) {
    const stockDisplay = p.stock === null ? '∞' : p.stock;
    const lowStockIndicator = p.stock !== null && p.stock > 0 && p.stock <= window.app.lowStockThreshold ? ` <i class="fas fa-exclamation-triangle text-yellow-500 text-xs" title="Stok Rendah"></i>` : '';
    
    let itemClasses = 'product-item clickable';
    if (p.stock !== null && p.stock === 0) {
        itemClasses += ' opacity-60 pointer-events-none';
    } else if (p.stock !== null && p.stock > 0 && p.stock <= window.app.lowStockThreshold) {
        itemClasses += ' low-stock-warning';
    }

    let hasDiscount = (p.discount && p.discount.value > 0) || (p.discountPercentage > 0);
    let discountedPrice = p.price;
    let discountText = '';
    if(hasDiscount) {
        const discount = p.discount || { type: 'percentage', value: p.discountPercentage };
        if (discount.type === 'percentage') {
            discountedPrice = p.price * (1 - discount.value / 100);
            discountText = `-${discount.value}%`;
        } else {
            discountedPrice = Math.max(0, p.price - discount.value);
            discountText = `-Rp`;
        }
    }

    let imageHtml = '';
    if (p.image) {
        imageHtml = `<img src="${p.image}" alt="${p.name}" class="product-image">`;
    } else if (p.hasImage) {
        imageHtml = `<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjwvc3ZnPg==" data-lazy-id="${p.id}" alt="${p.name}" class="product-image bg-gray-200 transition-opacity duration-300 opacity-50">`;
    } else {
        imageHtml = `<div class="bg-gray-100 rounded-lg p-4 mb-2"><i class="fas fa-box text-3xl text-gray-400"></i></div>`;
    }

    return `
    <div class="${itemClasses} relative" onclick="addToCart(${p.id})" data-name="${p.name.toLowerCase()}" data-category="${p.category ? p.category.toLowerCase() : ''}" data-barcode="${p.barcode || ''}">
        ${hasDiscount ? `<span class="absolute top-2 right-2 bg-red-500 text-white text-xs font-bold px-2 py-1 rounded-full z-10">${discountText}</span>` : ''}
        ${imageHtml}
        <h3 class="font-semibold text-sm">${p.name}</h3>
        ${hasDiscount
            ? `<div>
                 <p class="text-xs text-gray-500 line-through">Rp ${window.formatCurrency(p.price)}</p>
                 <p class="text-blue-500 font-bold">Rp ${window.formatCurrency(discountedPrice)}</p>
               </div>`
            : `<p class="text-blue-500 font-bold">Rp ${window.formatCurrency(p.price)}</p>`
        }
        <p class="text-xs text-gray-500">Stok: ${stockDisplay}${lowStockIndicator}</p>
    </div>`;
}

function renderProductListItem(p) {
    const profit = p.price - p.purchasePrice;
    const profitMargin = p.purchasePrice > 0 ? ((profit / p.purchasePrice) * 100).toFixed(1) : '&#8734;';
    const stockDisplay = p.stock === null ? '∞' : p.stock;
    const stockButtonsDisabled = p.stock === null;
    const decreaseButtonDisabled = stockButtonsDisabled || p.stock === 0;

    const lowStockBadge = p.stock !== null && p.stock > 0 && p.stock <= window.app.lowStockThreshold ? '<span class="low-stock-badge">Stok Rendah</span>' : '';
    const outOfStockClass = p.stock !== null && p.stock === 0 ? 'opacity-60' : '';
    const lowStockClass = p.stock !== null && p.stock > 0 && p.stock <= window.app.lowStockThreshold ? 'low-stock-warning' : '';

    let hasDiscount = (p.discount && p.discount.value > 0) || (p.discountPercentage > 0);
    let discountedPrice = p.price;
    let discountBadge = '';

    if(hasDiscount) {
        const discount = p.discount || { type: 'percentage', value: p.discountPercentage };
        if (discount.type === 'percentage') {
            discountedPrice = p.price * (1 - discount.value / 100);
            discountBadge = `<span class="bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">Diskon ${discount.value}%</span>`;
        } else { 
            discountedPrice = Math.max(0, p.price - discount.value);
            discountBadge = `<span class="bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">Diskon Rp</span>`;
        }
    }

    let imageHtml = '';
    if (p.image) {
        imageHtml = `<img src="${p.image}" alt="${p.name}" class="product-list-image">`;
    } else if (p.hasImage) {
        imageHtml = `<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjwvc3ZnPg==" data-lazy-id="${p.id}" alt="${p.name}" class="product-list-image bg-gray-200 transition-opacity duration-300 opacity-50">`;
    } else {
        imageHtml = `<div class="bg-gray-100 rounded-lg p-4 flex items-center justify-center" style="width: 60px; height: 60px;"><i class="fas fa-box text-2xl text-gray-400"></i></div>`;
    }

    return `
        <div id="product-card-${p.id}" class="card p-4 ${outOfStockClass} ${lowStockClass}">
            <div class="flex gap-3">
                ${imageHtml}
                <div class="flex-1">
                    <div class="flex justify-between items-start mb-2">
                        <div>
                            <h3 class="font-semibold">${p.name}</h3>
                            <p class="text-sm text-gray-600">${p.category}</p>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="editProduct(${p.id})" class="text-blue-500 clickable"><i class="fas fa-edit"></i></button>
                            <button onclick="deleteProduct(${p.id})" class="text-red-500 clickable"><i class="fas fa-trash"></i></button>
                        </div>
                    </div>
                    <div class="flex justify-between items-center">
                        <div>
                            ${hasDiscount
                                ? `<p class="text-xs text-gray-400 line-through">Rp ${window.formatCurrency(p.price)}</p>
                                   <p class="text-blue-500 font-bold">Rp ${window.formatCurrency(discountedPrice)}</p>`
                                : `<p class="text-blue-500 font-bold">Rp ${window.formatCurrency(p.price)}</p>`
                            }
                            <p class="text-xs text-gray-500">Beli: Rp ${window.formatCurrency(p.purchasePrice)}</p>
                        </div>
                        <div class="text-right">
                            <div class="flex justify-end items-center gap-2 mb-1">
                                ${discountBadge}
                                ${lowStockBadge}
                                <span class="profit-badge">+${profitMargin}%</span>
                            </div>
                            <div class="flex items-center justify-end gap-1">
                                <span class="text-sm text-gray-500 mr-1">Stok:</span>
                                <button onclick="decreaseStock(${p.id})" class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center clickable ${decreaseButtonDisabled ? 'opacity-50 cursor-not-allowed' : ''}" ${decreaseButtonDisabled ? 'disabled' : ''}><i class="fas fa-minus text-xs"></i></button>
                                <span id="stock-display-${p.id}" class="font-semibold text-base w-8 text-center">${stockDisplay}</span>
                                <button onclick="increaseStock(${p.id})" class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center clickable ${stockButtonsDisabled ? 'opacity-50 cursor-not-allowed' : ''}" ${stockButtonsDisabled ? 'disabled' : ''}><i class="fas fa-plus text-xs"></i></button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function searchProducts(e) {
    const query = e.target.value.toLowerCase();
    const isKasir = window.app.currentPage === 'kasir';
    
    if (isKasir) {
        const matches = window.app.productsCache.filter(p => 
            p.name.toLowerCase().includes(query) || 
            (p.barcode && p.barcode.toLowerCase().includes(query)) ||
            (p.category && p.category.toLowerCase().includes(query))
        );
        window.app.filteredGridProducts = matches;
        loadProductsGrid(true, true); 
    } else {
        loadProductsList(true, true); 
    }
}

export function handleSearchInputKeydown(e) {
    if (e.key === 'Enter') {
        const query = e.target.value.trim();
        if (!query) return;

        const product = window.app.productsCache.find(p => p.barcode === query);

        if (product) {
            e.preventDefault(); 
            
            if (typeof window.addToCart === 'function') {
                window.addToCart(product.id);
            }
            
            e.target.value = '';
            
            if (window.app.currentPage === 'kasir') {
                window.app.filteredGridProducts = [...window.app.productsCache];
                loadProductsGrid(true, true); 
            }
            
            e.target.focus();
        }
    }
}

export async function loadProductsGrid(isReset = true, useCache = false) {
    if (window.app.currentPage !== 'kasir') return;

    const grid = document.getElementById('productsGrid');
    const loadMoreBtn = document.getElementById('loadMoreGridContainer');
    
    if (isReset) {
        window.app.gridPage = 1;
        grid.innerHTML = '';
        
        if (!useCache) {
            const products = await getAllProductsLite();
            
            if (window.app.currentPage !== 'kasir') return;

            window.app.productsCache = products;
            window.app.filteredGridProducts = products;
        }
    }

    const { gridPage, itemsPerPage, filteredGridProducts } = window.app;
    
    if (filteredGridProducts.length === 0) {
        grid.innerHTML = `
            <div class="col-span-3 empty-state">
                <div class="empty-state-icon"><i class="fas fa-box-open"></i></div>
                <h3 class="empty-state-title">Produk Tidak Ditemukan</h3>
                <p class="empty-state-description">Coba kata kunci lain atau tambah produk baru.</p>
                <button onclick="showPage('produk')" class="empty-state-action">
                    <i class="fas fa-plus mr-2"></i>Tambah Produk
                </button>
            </div>
        `;
        loadMoreBtn.classList.add('hidden');
        return;
    }

    const start = (gridPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const itemsToShow = filteredGridProducts.slice(start, end);

    const html = itemsToShow.map(p => renderProductGridItem(p)).join('');
    
    if (isReset) {
        grid.innerHTML = html;
    } else {
        grid.insertAdjacentHTML('beforeend', html);
    }

    if (end < filteredGridProducts.length) {
        loadMoreBtn.classList.remove('hidden');
    } else {
        loadMoreBtn.classList.add('hidden');
    }

    loadVisibleImages();
}

export function loadMoreProductsGrid() {
    window.app.gridPage++;
    loadProductsGrid(false, true); 
}

export async function loadProductsList(isReset = true, useCache = false) {
    if (window.app.currentPage !== 'produk') return;

    const list = document.getElementById('productsList');
    const loadMoreBtn = document.getElementById('loadMoreListContainer');
    const filterSelect = document.getElementById('productCategoryFilter');
    
    const thresholdSpan = document.getElementById('lowStockThresholdDisplay');
    if (thresholdSpan) thresholdSpan.textContent = window.app.lowStockThreshold;
    
    updateLowStockFilterUI();
    updateExpiringFilterUI();

    if (!useCache && isReset) {
        await populateCategoryDropdowns(['productCategoryFilter']);
    }
    
    const selectedCategory = filterSelect ? filterSelect.value : 'all';
    const searchQuery = document.getElementById('searchProductList')?.value?.toLowerCase() || '';

    if (isReset) {
        window.app.listPage = 1;
        list.innerHTML = '';
        
        if (!useCache || !window.app.productsCache || window.app.productsCache.length === 0) {
            const products = await getAllProductsLite();
            
            if (window.app.currentPage !== 'produk') return;

            window.app.productsCache = products; 
        }
        
        let filtered = window.app.productsCache;
        
        if (isLowStockFilterActive) {
             let threshold = parseInt(window.app.lowStockThreshold);
             if (isNaN(threshold)) threshold = 5; 

             filtered = filtered.filter(p => {
                 if (p.stock === null) return false;
                 const stockVal = Number(p.stock);
                 return stockVal > 0 && stockVal <= threshold; 
             });
        }

        if (isExpiringFilterActive) {
             const today = new Date();
             today.setHours(0, 0, 0, 0);
             const thirtyDaysFromNow = new Date(today);
             thirtyDaysFromNow.setDate(today.getDate() + 30);

             filtered = filtered.filter(p => {
                 if (!p.expiryDate) return false;
                 const expiry = new Date(p.expiryDate);
                 return expiry <= thirtyDaysFromNow;
             });
        }

        if (selectedCategory !== 'all') {
            filtered = filtered.filter(p => p.category === selectedCategory);
        }
        
        if (searchQuery) {
            filtered = filtered.filter(p => 
                p.name.toLowerCase().includes(searchQuery) || 
                (p.barcode && p.barcode.toLowerCase().includes(searchQuery)) ||
                (p.category && p.category.toLowerCase().includes(searchQuery))
            );
        }

        filtered.sort((a, b) => a.name.localeCompare(b.name));
        window.app.filteredListProducts = filtered;
    }

    const { listPage, itemsPerPage, filteredListProducts } = window.app;

    if (filteredListProducts.length === 0) {
        list.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-search"></i></div>
                <h3 class="empty-state-title">Produk Tidak Ditemukan</h3>
                <p class="empty-state-description">Tidak ada produk yang cocok dengan pencarian.</p>
                <button onclick="showAddProductModal()" class="empty-state-action">
                    <i class="fas fa-plus mr-2"></i>Tambah Produk
                </button>
            </div>
        `;
        loadMoreBtn.classList.add('hidden');
        return;
    }

    const start = (listPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const itemsToShow = filteredListProducts.slice(start, end);

    const html = itemsToShow.map(p => renderProductListItem(p)).join('');

    if (isReset) {
        list.innerHTML = html;
    } else {
        list.insertAdjacentHTML('beforeend', html);
    }

    if (end < filteredListProducts.length) {
        loadMoreBtn.classList.remove('hidden');
    } else {
        loadMoreBtn.classList.add('hidden');
    }

    loadVisibleImages();
}

export function loadMoreProductsList() {
    window.app.listPage++;
    loadProductsList(false, true);
}

// --- STOCK HISTORY ---
export async function showStockHistoryModal() {
    const modal = document.getElementById('stockHistoryModal');
    const list = document.getElementById('stockHistoryList');
    
    list.innerHTML = '<p class="text-center text-gray-500">Memuat...</p>';
    modal.classList.remove('hidden');

    try {
        const history = await getAllFromDB('stock_history');
        if (history.length === 0) {
            list.innerHTML = '<p class="text-center text-gray-500">Belum ada riwayat stok.</p>';
            return;
        }
        
        history.sort((a,b) => new Date(b.date) - new Date(a.date));
        
        list.innerHTML = history.slice(0, 50).map(h => {
             const date = new Date(h.date).toLocaleString('id-ID');
             const diffSign = h.changeAmount > 0 ? '+' : '';
             const color = h.changeAmount > 0 ? 'text-green-600' : 'text-red-600';
             
             return `
                <div class="border-b py-2 last:border-b-0">
                    <div class="flex justify-between">
                        <span class="font-semibold">${h.productName} ${h.variationName ? `(${h.variationName})` : ''}</span>
                        <span class="${color} font-bold">${diffSign}${h.changeAmount}</span>
                    </div>
                    <div class="flex justify-between text-xs text-gray-500 mt-1">
                        <span>${h.reason} (${h.type}) - ${h.userName}</span>
                        <span>${date}</span>
                    </div>
                    <div class="text-xs text-gray-400">
                        Stok: ${h.oldStock} &rarr; ${h.newStock}
                    </div>
                </div>
             `;
        }).join('');

    } catch (e) {
        console.error("Error loading stock history", e);
        list.innerHTML = '<p class="text-center text-red-500">Gagal memuat riwayat.</p>';
    }
}

export function closeStockHistoryModal() {
    document.getElementById('stockHistoryModal').classList.add('hidden');
}
