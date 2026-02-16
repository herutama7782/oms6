
import { getFromDB, getSettingFromDB, putToDB, getAllFromDB } from './db.js';
// REMOVED: import { showToast, showConfirmationModal, formatCurrency, updatePendingBadge } from './ui.js';
import { playTone } from './audio.js';
// REMOVED: import { printReceipt } from './peripherals.js'; // Circular dependency fix
import { queueSyncAction } from './sync.js';
import { applyDefaultFees } from './settings.js';
import { loadProductsGrid, logStockChange } from './product.js';
// REMOVED: import { loadDashboard } from './ui.js';

// State for payment method in the modal
let currentPaymentMethod = 'cash';
let searchTimeout; // For debouncing customer search

/**
 * Calculates the effective price for a product based on quantity,
 * considering wholesale pricing tiers and then applying a discount.
 * @param {object} product The full product object from the database.
 * @param {number} quantity The quantity of the product.
 * @returns {{basePrice: number, effectivePrice: number, isWholesale: boolean}} An object containing the price before discount, the final price, and a flag indicating if wholesale pricing was used.
 */
function getEffectivePriceForProduct(product, quantity) {
    let basePrice = product.price; // Start with the regular selling price
    let isWholesale = false;

    // Check if a wholesale price tier applies
    if (product.wholesalePrices && product.wholesalePrices.length > 0) {
        const applicableTiers = product.wholesalePrices
            .filter(tier => quantity >= tier.min)
            .sort((a, b) => b.min - a.min); // Prioritize tier with higher min quantity

        if (applicableTiers.length > 0) {
            const bestTier = applicableTiers[0];
            // A null/undefined max means it applies to all quantities above min
            if (bestTier.max === null || bestTier.max === undefined || quantity <= bestTier.max) {
                basePrice = bestTier.price; // A wholesale price applies, update the base price
                isWholesale = true;
            }
        }
    }

    // Now, apply the discount to the determined base price (either regular or wholesale)
    let effectivePrice = basePrice;
    if (product.discount && product.discount.value > 0) {
        if (product.discount.type === 'percentage') {
            effectivePrice = basePrice * (1 - product.discount.value / 100);
        } else { // fixed
            effectivePrice = Math.max(0, basePrice - product.discount.value);
        }
    } else if (product.discountPercentage && product.discountPercentage > 0) { // For backward compatibility
        effectivePrice = basePrice * (1 - product.discountPercentage / 100);
    }

    return { basePrice, effectivePrice, isWholesale };
}

/**
 * Calculates the effective price for a single product variation based on quantity,
 * considering its own wholesale pricing tiers and the main product's discount.
 * @param {object} product The parent product object.
 * @param {object} variation The variation object from a product.
 * @param {number} quantity The quantity of the variation.
 * @returns {{basePrice: number, effectivePrice: number, isWholesale: boolean}} Price details.
 */
function getEffectivePriceForVariation(product, variation, quantity) {
    let basePrice = variation.price;
    let isWholesale = false;

    if (variation.wholesalePrices && variation.wholesalePrices.length > 0) {
        const applicableTiers = variation.wholesalePrices
            .filter(tier => quantity >= tier.min)
            .sort((a, b) => b.min - a.min);

        if (applicableTiers.length > 0) {
            const bestTier = applicableTiers[0];
            if (bestTier.max === null || bestTier.max === undefined || quantity <= bestTier.max) {
                basePrice = bestTier.price;
                isWholesale = true;
            }
        }
    }
    
    // Apply the main product discount to the variation's price
    let effectivePrice = basePrice;
    if (product.discount && product.discount.value > 0) {
        if (product.discount.type === 'percentage') {
            effectivePrice = basePrice * (1 - product.discount.value / 100);
        } else { // fixed
            effectivePrice = Math.max(0, basePrice - product.discount.value);
        }
    } else if (product.discountPercentage && product.discountPercentage > 0) { // For backward compatibility
        effectivePrice = basePrice * (1 - product.discountPercentage / 100);
    }
    
    return { basePrice, effectivePrice, isWholesale };
}


// --- Cart Modal Functions ---
export function showCartModal() {
    updateCartDisplay(); // Ensure content is up-to-date
    const modal = document.getElementById('cartModal');
    const sheet = document.getElementById('cartSection');
    const bottomNav = document.getElementById('bottomNav');
    const cartFab = document.getElementById('cartFab');
    if (!modal || !sheet) return;

    if (bottomNav) bottomNav.classList.add('hidden');
    if (cartFab) cartFab.classList.add('hidden');

    modal.classList.remove('hidden');
    requestAnimationFrame(() => {
        sheet.classList.add('show');
    });
}

export function hideCartModal() {
    const modal = document.getElementById('cartModal');
    const sheet = document.getElementById('cartSection');
    const bottomNav = document.getElementById('bottomNav');
    const cartFab = document.getElementById('cartFab');
    if (!modal || !sheet) return;
    
    // Show nav and FAB again
    if (bottomNav) {
        bottomNav.classList.remove('hidden');
    }
    if (cartFab && window.app.currentPage === 'kasir') {
        cartFab.classList.remove('hidden');
    }

    sheet.classList.remove('show');
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 300); // Must match CSS transition duration
}

export function updateCartFabBadge() {
    const badge = document.getElementById('cartBadge');
    if (!badge) return;

    const totalItems = window.app.cart.items.reduce((sum, item) => sum + item.quantity, 0);

    if (totalItems > 0) {
        badge.textContent = totalItems > 99 ? '99+' : totalItems;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// --- CART MANAGEMENT ---
export async function addToCart(productId) {
    try {
        const product = await getFromDB('products', productId);
        if (!product) {
            window.showToast('Produk tidak ditemukan.');
            return;
        }

        // Check for variations and show selection modal if they exist
        if (product.variations && product.variations.length > 0) {
            showVariationSelectionModal(product);
            return; // Stop here, let the variation modal handle adding to cart
        }

        if (product.stock !== null && product.stock === 0) {
            window.showToast('Produk habis.');
            return;
        }

        const existingItem = window.app.cart.items.find(item => item.id === productId);
        
        if (existingItem) {
            if (product.stock === null || existingItem.quantity < product.stock) {
                existingItem.quantity++;
                // Recalculate price based on new quantity
                const priceInfo = getEffectivePriceForProduct(product, existingItem.quantity);
                existingItem.basePrice = priceInfo.basePrice;
                existingItem.effectivePrice = priceInfo.effectivePrice;
                existingItem.isWholesale = priceInfo.isWholesale;
            } else {
                window.showToast(`Stok ${product.name} tidak mencukupi.`);
                return;
            }
        } else {
            // Calculate initial price based on quantity 1
            const priceInfo = getEffectivePriceForProduct(product, 1);

            window.app.cart.items.push({ 
                id: product.id, 
                name: product.name, 
                price: product.price, // Original price for reference
                basePrice: priceInfo.basePrice,
                effectivePrice: priceInfo.effectivePrice, // Price after discount OR wholesale
                isWholesale: priceInfo.isWholesale,
                discount: product.discount || (product.discountPercentage ? { type: 'percentage', value: product.discountPercentage } : null),
                quantity: 1, 
                stock: product.stock 
            });
        }
        
        playTone(1200, 0.1, 0.3, 'square');
        window.showToast(`${product.name} ditambahkan ke keranjang`);
        updateCartDisplay(); // Update display to reflect potential price change
    } catch (error) {
        console.error('Failed to add to cart:', error);
        window.showToast('Gagal menambahkan produk ke keranjang.');
    }
}

export async function updateCartItemQuantity(itemId, change) {
    const item = window.app.cart.items.find(i => String(i.id) === itemId);
    if (!item) return;

    // Check if it's a variation item by checking for the composite ID format
    if (String(item.id).includes('-')) {
        const [productIdStr, variationIndexStr] = String(item.id).split('-');
        const productId = parseInt(productIdStr);
        const variationIndex = parseInt(variationIndexStr);

        const product = await getFromDB('products', productId);
        const variation = product?.variations?.[variationIndex];

        if (!variation) {
            window.showToast('Variasi produk tidak ditemukan, hapus dari keranjang.');
            window.app.cart.items = window.app.cart.items.filter(i => i.id !== itemId);
        } else {
            const newQuantity = item.quantity + change;
            if (newQuantity > 0 && (variation.stock === null || newQuantity <= variation.stock)) {
                item.quantity = newQuantity;
                const priceInfo = getEffectivePriceForVariation(product, variation, newQuantity);
                item.basePrice = priceInfo.basePrice;
                item.effectivePrice = priceInfo.effectivePrice;
                item.isWholesale = priceInfo.isWholesale;
            } else if (variation.stock !== null && newQuantity > variation.stock) {
                window.showToast(`Stok variasi ${variation.name} tidak mencukupi. Sisa ${variation.stock}.`);
            } else {
                window.app.cart.items = window.app.cart.items.filter(i => i.id !== itemId);
            }
        }
    } else { // It's a regular product
        const productId = item.id;
        const newQuantity = item.quantity + change;
        const product = await getFromDB('products', productId);

        if (!product) {
            window.showToast('Produk tidak ditemukan, hapus dari keranjang.');
            window.app.cart.items = window.app.cart.items.filter(i => i.id !== productId);
        } else {
            if (newQuantity > 0 && (product.stock === null || newQuantity <= product.stock)) {
                item.quantity = newQuantity;
                const priceInfo = getEffectivePriceForProduct(product, newQuantity);
                item.basePrice = priceInfo.basePrice;
                item.effectivePrice = priceInfo.effectivePrice;
                item.isWholesale = priceInfo.isWholesale;
            } else if (product.stock !== null && newQuantity > product.stock) {
                window.showToast(`Stok tidak mencukupi. Sisa ${product.stock}.`);
            } else {
                window.app.cart.items = window.app.cart.items.filter(i => i.id !== productId);
            }
        }
    }
    
    updateCartDisplay();
}

export function updateCartDisplay() {
    const cartItemsEl = document.getElementById('cartItems');
    const cartSubtotalEl = document.getElementById('cartSubtotal');
    const cartTotalEl = document.getElementById('cartTotal');
    const cartFeesEl = document.getElementById('cartFees');
    const paymentButton = document.querySelector('#cartSection button[onclick="showPaymentModal()"]');
    const selectedCustomerDisplay = document.getElementById('selectedCustomerDisplay');
    const selectedCustomerName = document.getElementById('selectedCustomerName');
    const customerSearchContainer = document.getElementById('customerSearchContainer');
    
    if (window.app.cart.items.length === 0) {
        cartItemsEl.innerHTML = `<p class="text-gray-500 text-center py-4">Keranjang kosong</p>`;
        paymentButton.disabled = true;
        paymentButton.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
        cartItemsEl.innerHTML = window.app.cart.items.map(item => `
            <div class="cart-item flex items-center justify-between">
                <div>
                    <p class="font-semibold">${item.name}</p>
                    <p class="text-sm text-gray-600">Rp ${window.formatCurrency(item.effectivePrice)}</p>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="updateCartItemQuantity('${item.id}', -1)" class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center clickable"><i class="fas fa-minus text-xs"></i></button>
                    <span>${item.quantity}</span>
                    <button onclick="updateCartItemQuantity('${item.id}', 1)" class="w-6 h-6 rounded-full bg-gray-200 flex items-center justify-center clickable"><i class="fas fa-plus text-xs"></i></button>
                </div>
            </div>
        `).join('');
        paymentButton.disabled = false;
        paymentButton.classList.remove('opacity-50', 'cursor-not-allowed');
    }

    if (window.app.cart.customerName) {
        selectedCustomerName.textContent = window.app.cart.customerName;
        selectedCustomerDisplay.classList.remove('hidden');
        customerSearchContainer.classList.add('hidden');
    } else {
        selectedCustomerDisplay.classList.add('hidden');
        customerSearchContainer.classList.remove('hidden');
        document.getElementById('customerSearchInput').value = '';
    }
    
    const subtotal = window.app.cart.items.reduce((sum, item) => sum + Math.round(item.effectivePrice * item.quantity), 0);
    
    let totalFees = 0;
    cartFeesEl.innerHTML = '';
    window.app.cart.fees.forEach(fee => {
        const feeAmountRaw = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        const feeAmount = Math.round(feeAmountRaw);
        totalFees += feeAmount;
        
        const feeElement = document.createElement('div');
        feeElement.className = 'flex justify-between';
        feeElement.innerHTML = `
            <span>${fee.name} (${fee.type === 'percentage' ? `${fee.value}%` : `Rp ${window.formatCurrency(fee.value)}`}):</span>
            <span>Rp ${window.formatCurrency(feeAmount)}</span>
        `;
        cartFeesEl.appendChild(feeElement);
    });
    
    const total = subtotal + totalFees;

    cartSubtotalEl.textContent = `Rp ${window.formatCurrency(subtotal)}`;
    cartTotalEl.textContent = `Rp ${window.formatCurrency(total)}`;

    updateCartFabBadge();
}

export function clearCart() {
    if (window.app.cart.items.length === 0 && !window.app.cart.customerId) return;
    window.showConfirmationModal('Kosongkan Keranjang', 'Apakah Anda yakin ingin mengosongkan keranjang?', () => {
        window.app.cart.items = [];
        window.app.cart.customerId = null;
        window.app.cart.customerName = null;
        applyDefaultFees();
        updateCartDisplay();
        window.showToast('Keranjang dikosongkan.');
    });
}

// --- VARIATION SELECTION ---

export function showVariationSelectionModal(product) {
    const modal = document.getElementById('variationSelectionModal');
    const titleEl = document.getElementById('variationModalTitle');
    const listEl = document.getElementById('variationList');

    if (!modal || !titleEl || !listEl) return;

    titleEl.textContent = `Pilih Variasi - ${product.name}`;
    listEl.innerHTML = product.variations.map((variation, index) => {
        if (!variation.name || !variation.price) return ''; 

        const stockDisplay = variation.stock === null ? '∞' : (variation.stock || 0);
        const isDisabled = variation.stock !== null && (variation.stock || 0) <= 0;
        const disabledClasses = isDisabled ? 'opacity-50 cursor-not-allowed' : 'clickable hover:bg-gray-100';
        const onClickAction = isDisabled ? '' : `onclick="addVariationToCart(${product.id}, ${index})"`;

        return `
            <div class="flex justify-between items-center p-3 border rounded-lg ${disabledClasses}" ${onClickAction}>
                <div>
                    <p class="font-semibold">${variation.name}</p>
                    <p class="text-sm text-gray-500">Stok: ${stockDisplay}</p>
                </div>
                <p class="font-bold text-blue-600">Rp ${window.formatCurrency(variation.price)}</p>
            </div>
        `;
    }).join('');

    modal.classList.remove('hidden');
}

export function closeVariationSelectionModal() {
    const modal = document.getElementById('variationSelectionModal');
    if (modal) {
        modal.classList.add('hidden');
    }
}

export async function addVariationToCart(productId, variationIndex) {
    try {
        const product = await getFromDB('products', productId);
        if (!product || !product.variations || !product.variations[variationIndex]) {
            window.showToast('Variasi produk tidak valid.');
            return;
        }
        
        const variation = product.variations[variationIndex];
        const variationId = `${product.id}-${variationIndex}`;

        if (variation.stock !== null && (variation.stock || 0) <= 0) {
            window.showToast(`Stok untuk variasi ${variation.name} habis.`);
            return;
        }

        const existingItem = window.app.cart.items.find(item => item.id === variationId);

        if (existingItem) {
            if (variation.stock === null || existingItem.quantity < variation.stock) {
                existingItem.quantity++;
                const priceInfo = getEffectivePriceForVariation(product, variation, existingItem.quantity);
                existingItem.basePrice = priceInfo.basePrice;
                existingItem.effectivePrice = priceInfo.effectivePrice;
                existingItem.isWholesale = priceInfo.isWholesale;
            } else {
                window.showToast(`Stok untuk variasi ${variation.name} tidak mencukupi.`);
                return;
            }
        } else {
            const priceInfo = getEffectivePriceForVariation(product, variation, 1);
            window.app.cart.items.push({
                id: variationId,
                productId: product.id,
                variationIndex: variationIndex,
                variationName: variation.name,
                name: `${product.name} (${variation.name})`,
                price: variation.price,
                basePrice: priceInfo.basePrice,
                effectivePrice: priceInfo.effectivePrice,
                isWholesale: priceInfo.isWholesale,
                discount: product.discount || (product.discountPercentage ? { type: 'percentage', value: product.discountPercentage } : null),
                quantity: 1,
                stock: variation.stock,
                wholesalePrices: variation.wholesalePrices || []
            });
        }

        playTone(1200, 0.1, 0.3, 'square');
        window.showToast(`${product.name} (${variation.name}) ditambahkan ke keranjang`);
        closeVariationSelectionModal();
        updateCartDisplay();

    } catch (error) {
        console.error('Failed to add variation to cart:', error);
        window.showToast('Gagal menambahkan variasi ke keranjang.');
    }
}


// --- CHECKOUT PROCESS ---

export async function selectPaymentMethod(method) {
    currentPaymentMethod = method;
    const cashBtn = document.getElementById('paymentMethodCash');
    const qrisBtn = document.getElementById('paymentMethodQris');
    const debtBtn = document.getElementById('paymentMethodDebt');
    const cashFields = document.getElementById('cashPaymentFields');
    const cashInput = document.getElementById('cashPaidInput');
    const completeButton = document.getElementById('completeTransactionButton');
    const debtNote = document.getElementById('debtNote');

    // Helper to reset style
    const setInactive = (btn) => {
        if(btn) {
            btn.classList.replace('bg-blue-500', 'bg-gray-200');
            btn.classList.replace('text-white', 'text-gray-700');
        }
    };
    const setActive = (btn) => {
        if(btn) {
            btn.classList.replace('bg-gray-200', 'bg-blue-500');
            btn.classList.replace('text-gray-700', 'text-white');
        }
    };

    setInactive(cashBtn);
    setInactive(qrisBtn);
    setInactive(debtBtn);
    
    if (debtNote) {
        if (method === 'debt') {
            debtNote.classList.remove('hidden');
        } else {
            debtNote.classList.add('hidden');
        }
    }

    if (method === 'cash') {
        setActive(cashBtn);
        cashFields.style.display = 'block';
        cashInput.value = '';
        cashInput.placeholder = '0';
        cashInput.dispatchEvent(new Event('input')); // Trigger update to recalculate change
    } else if (method === 'debt') {
        setActive(debtBtn);
        cashFields.style.display = 'block';
        cashInput.value = '';
        cashInput.placeholder = '0 (DP)'; // Down Payment hint
        
        // Check if customer is selected
        if (!window.app.cart.customerId) {
            window.showToast('Apakah sudah menambahkan nama pelanggan ?');
        } else {
            window.showToast('Nama pelanggan sudah sesuai ?');
        }

        cashInput.dispatchEvent(new Event('input')); 
    } else { // QRIS
        setActive(qrisBtn);
        cashFields.style.display = 'none';

        // Auto-fill amount for QRIS
        const subtotal = window.app.cart.items.reduce((sum, item) => sum + Math.round(item.effectivePrice * item.quantity), 0);
        let totalFees = 0;
        window.app.cart.fees.forEach(fee => {
            const feeAmountRaw = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
            totalFees += Math.round(feeAmountRaw);
        });
        const finalTotal = subtotal + totalFees;
        
        const enableDonation = await getSettingFromDB('enableDonationRounding');
        let grandTotal = finalTotal;
        if (enableDonation && finalTotal > 0 && finalTotal % 1000 !== 0) {
            grandTotal = Math.ceil(finalTotal / 1000) * 1000;
        }
        
        cashInput.value = grandTotal;
        cashInput.dispatchEvent(new Event('input')); // Trigger update
        completeButton.disabled = false;
        completeButton.classList.remove('disabled:bg-blue-300');
    }
}

export async function showPaymentModal() {
    if (window.app.cart.items.length === 0) {
        window.showToast('Keranjang kosong. Tidak dapat melakukan pembayaran.');
        return;
    }
    const subtotal = window.app.cart.items.reduce((sum, item) => sum + Math.round(item.effectivePrice * item.quantity), 0);

    let totalFees = 0;
    window.app.cart.fees.forEach(fee => {
        const feeAmountRaw = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        totalFees += Math.round(feeAmountRaw);
    });
    const originalTotal = subtotal + totalFees;

    const enableDonation = await getSettingFromDB('enableDonationRounding');

    let finalTotal = originalTotal;
    let donationAmount = 0;

    const donationLine = document.getElementById('donationLine');
    const paymentTotalOriginalEl = document.getElementById('paymentTotalOriginal');
    const donationToggle = document.getElementById('donationToggle');

    if (enableDonation && originalTotal > 0 && originalTotal % 1000 !== 0) {
        finalTotal = Math.ceil(originalTotal / 1000) * 1000;
        donationAmount = finalTotal - originalTotal;
        
        paymentTotalOriginalEl.textContent = `Rp ${window.formatCurrency(originalTotal)}`;
        document.getElementById('paymentDonation').textContent = `Rp ${window.formatCurrency(donationAmount)}`;
        donationLine.classList.remove('hidden');
        if (paymentTotalOriginalEl) paymentTotalOriginalEl.parentElement.classList.remove('hidden');
        if (donationToggle) donationToggle.checked = true;
    } else {
        donationLine.classList.add('hidden');
        if (paymentTotalOriginalEl) paymentTotalOriginalEl.parentElement.classList.add('hidden');
        if (donationToggle) donationToggle.checked = false;
    }

    (document.getElementById('paymentTotal')).textContent = `Rp ${window.formatCurrency(finalTotal)}`;
    (document.getElementById('paymentModal')).classList.remove('hidden');
    
    // Reset to default cash payment method
    selectPaymentMethod('cash');

    const cashInput = document.getElementById('cashPaidInput');
    cashInput.focus();
}

export function closePaymentModal() {
    (document.getElementById('paymentModal')).classList.add('hidden');
}

export function handleQuickCash(amount) {
    const cashInput = document.getElementById('cashPaidInput');
    cashInput.value = amount;
    cashInput.dispatchEvent(new Event('input'));
}

export function handleDonationToggle() {
    // Recalculate originalTotal
    const subtotal = window.app.cart.items.reduce((sum, item) => sum + Math.round(item.effectivePrice * item.quantity), 0);
    let totalFees = 0;
    window.app.cart.fees.forEach(fee => {
        const feeAmountRaw = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        totalFees += Math.round(feeAmountRaw);
    });
    const originalTotal = subtotal + totalFees;

    const donationToggle = document.getElementById('donationToggle');
    let newTotal = originalTotal;

    if (donationToggle.checked) {
        if (originalTotal > 0 && originalTotal % 1000 !== 0) {
            newTotal = Math.ceil(originalTotal / 1000) * 1000;
        }
    }

    // Update UI
    document.getElementById('paymentTotal').textContent = `Rp ${window.formatCurrency(newTotal)}`;

    // Trigger change calculation
    const cashInput = document.getElementById('cashPaidInput');
    cashInput.dispatchEvent(new Event('input'));
}


export async function updatePaymentChange(e) {
    const cashPaidValue = e.target.value;

    const subtotal = window.app.cart.items.reduce((sum, item) => sum + Math.round(item.effectivePrice * item.quantity), 0);
    let totalFees = 0;
    window.app.cart.fees.forEach(fee => {
        const feeAmountRaw = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
        totalFees += Math.round(feeAmountRaw);
    });
    const originalTotal = subtotal + totalFees;

    const enableDonation = await getSettingFromDB('enableDonationRounding');
    const donationToggle = document.getElementById('donationToggle');
    
    let total = originalTotal;
    if (enableDonation && donationToggle && donationToggle.checked && originalTotal > 0 && originalTotal % 1000 !== 0) {
        total = Math.ceil(originalTotal / 1000) * 1000;
    }

    const changeEl = document.getElementById('paymentChange');
    const changeLabelEl = document.getElementById('paymentChangeLabel');
    const completeButton = document.getElementById('completeTransactionButton');

    // For QRIS, change is always 0 and payment is always exact
    if (currentPaymentMethod === 'qris') {
        changeEl.textContent = 'Rp 0';
        changeLabelEl.textContent = 'Kembalian:';
        changeEl.classList.remove('text-red-500');
        changeEl.classList.add('text-green-500');
        completeButton.disabled = false;
        completeButton.classList.remove('disabled:bg-blue-300');
        return;
    }

    const cashPaid = parseFloat(cashPaidValue) || 0;
    const change = cashPaid - total;
    
    if (change >= 0) {
        changeEl.textContent = `Rp ${window.formatCurrency(change)}`;
        changeEl.classList.remove('text-red-500');
        changeEl.classList.add('text-green-500');
        changeLabelEl.textContent = 'Kembalian:';
        completeButton.disabled = false;
        completeButton.classList.remove('disabled:bg-blue-300');
    } else {
        changeEl.textContent = `Rp ${window.formatCurrency(Math.abs(change))}`;
        
        if (currentPaymentMethod === 'debt') {
            // Negative change allowed for Debt (Piutang)
            changeEl.classList.add('text-red-500');
            changeEl.classList.remove('text-green-500');
            changeLabelEl.textContent = 'Masuk Piutang:';
            completeButton.disabled = false;
            completeButton.classList.remove('disabled:bg-blue-300');
        } else {
            // Not allowed for Cash
            changeEl.classList.add('text-red-500');
            changeEl.classList.remove('text-green-500');
            changeLabelEl.textContent = 'Kurang:';
            completeButton.disabled = true;
            completeButton.classList.add('disabled:bg-blue-300');
        }
    }
};

export async function completeTransaction() {
    const button = document.getElementById('completeTransactionButton');
    const buttonText = button.querySelector('.payment-button-text');
    const spinner = button.querySelector('.payment-button-spinner');

    // Validate Debt Customer First
    if (currentPaymentMethod === 'debt' && !window.app.cart.customerId) {
        window.showToast('Harap pilih pelanggan untuk transaksi piutang.');
        return;
    }

    button.disabled = true;
    buttonText.classList.add('hidden');
    spinner.classList.remove('hidden');

    try {
        const subtotalAfterDiscount = window.app.cart.items.reduce((sum, item) => {
            return sum + Math.round(item.effectivePrice * item.quantity);
        }, 0);

        let calculatedFees = [];
        let totalFeeAmount = 0;
        window.app.cart.fees.forEach(fee => {
            const feeAmountRaw = fee.type === 'percentage' 
                ? subtotalAfterDiscount * (fee.value / 100) 
                : fee.value;
            const roundedFeeAmount = Math.round(feeAmountRaw);
            calculatedFees.push({ ...fee, amount: roundedFeeAmount });
            totalFeeAmount += roundedFeeAmount;
        });

        const total = subtotalAfterDiscount + totalFeeAmount;
        
        const enableDonation = await getSettingFromDB('enableDonationRounding');
        const donationToggle = document.getElementById('donationToggle');
        
        let grandTotal = total;
        let donationAmount = 0;

        if (enableDonation && donationToggle && donationToggle.checked && total > 0 && total % 1000 !== 0) {
            grandTotal = Math.ceil(total / 1000) * 1000;
            donationAmount = grandTotal - total;
        }

        const cashPaid = (currentPaymentMethod === 'qris')
            ? grandTotal
            : Math.round(parseFloat(document.getElementById('cashPaidInput').value) || 0);

        const change = cashPaid - grandTotal;

        const subtotal_for_report = window.app.cart.items.reduce((sum, item) => sum + (item.basePrice * item.quantity), 0);
        const totalDiscount_for_report = window.app.cart.items.reduce((sum, item) => {
             return sum + ((item.basePrice - item.effectivePrice) * item.quantity);
        }, 0);

        const currentUser = window.app.currentUser;
        
        let paymentMethodLabel = 'TUNAI';
        if (currentPaymentMethod === 'qris') paymentMethodLabel = 'QRIS';
        if (currentPaymentMethod === 'debt') paymentMethodLabel = 'PIUTANG';

        const transaction = {
            items: window.app.cart.items.map(item => ({
                id: item.id,
                productId: item.productId,
                variationIndex: item.variationIndex,
                variationName: item.variationName,
                name: item.name,
                quantity: item.quantity,
                price: item.price,
                effectivePrice: item.effectivePrice,
                basePrice: item.basePrice,
                isWholesale: item.isWholesale || false,
                discount: item.discount,
            })),
            subtotal: subtotal_for_report,
            totalDiscount: totalDiscount_for_report,
            fees: calculatedFees,
            total: total,
            donation: donationAmount,
            grandTotal: grandTotal,
            cashPaid: cashPaid,
            change: change,
            paymentMethod: paymentMethodLabel,
            customerId: window.app.cart.customerId,
            customerName: window.app.cart.customerName,
            userId: currentUser ? currentUser.id : null,
            userName: currentUser ? currentUser.name : 'N/A',
            date: new Date().toISOString(),
            pointsEarned: 0 // Initialize
        };

        // --- POINT SYSTEM LOGIC ---
        const pointSystemEnabled = await getSettingFromDB('pointSystemEnabled');
        if (pointSystemEnabled && transaction.customerId) {
            const pointMinPurchase = await getSettingFromDB('pointMinPurchase') || 0;
            const pointValuePerPoint = await getSettingFromDB('pointValuePerPoint') || 0;
            
            if (pointValuePerPoint > 0 && transaction.total >= pointMinPurchase) {
                const pointsEarned = Math.floor(transaction.total / pointValuePerPoint);
                if (pointsEarned > 0) {
                    transaction.pointsEarned = pointsEarned;
                    
                    const customer = await getFromDB('contacts', transaction.customerId);
                    if (customer) {
                        customer.points = (customer.points || 0) + pointsEarned;
                        customer.updatedAt = new Date().toISOString();
                        await putToDB('contacts', customer);
                        await queueSyncAction('UPDATE_CONTACT', customer);
                    }
                }
            }
        }
        // --- END POINT SYSTEM LOGIC ---

        const addedId = await putToDB('transactions', transaction);
        await queueSyncAction('CREATE_TRANSACTION', { ...transaction, id: addedId });

        // --- NEW: Handle Ledger for Debt ---
        if (currentPaymentMethod === 'debt' && change < 0) {
             const debtAmount = Math.abs(change);
             const ledgerEntry = {
                 contactId: window.app.cart.customerId,
                 amount: debtAmount,
                 description: `Piutang Transaksi #${addedId}`,
                 type: 'debit', // Debit increases receivable (Piutang)
                 date: new Date().toISOString(),
                 createdAt: new Date().toISOString(),
                 updatedAt: new Date().toISOString()
             };
             const ledgerId = await putToDB('ledgers', ledgerEntry);
             await queueSyncAction('CREATE_LEDGER', { ...ledgerEntry, id: ledgerId });
        }

        for (const item of window.app.cart.items) {
            if (item.stock === null) continue; // Skip stock reduction for unlimited stock items

            const productId = String(item.id).includes('-') ? item.productId : item.id;
            const product = await getFromDB('products', productId);

            if (product) {
                const oldStock = product.stock;
                let newStock = oldStock;
                let variationName = null;

                if (String(item.id).includes('-') && product.variations && product.variations[item.variationIndex] !== undefined) {
                    const oldVarStock = product.variations[item.variationIndex].stock || 0;
                    product.variations[item.variationIndex].stock -= item.quantity;
                    newStock = product.variations.reduce((total, v) => total + (v.stock || 0), 0);
                    variationName = product.variations[item.variationIndex].name;
                    
                    await logStockChange({
                        productId: product.id,
                        productName: product.name,
                        variationName: variationName,
                        oldStock: oldVarStock,
                        newStock: product.variations[item.variationIndex].stock,
                        type: 'sale',
                        reason: `Penjualan #${addedId}`
                    });

                } else {
                    product.stock -= item.quantity;
                    newStock = product.stock;
                    
                    await logStockChange({
                        productId: product.id,
                        productName: product.name,
                        oldStock: oldStock,
                        newStock: newStock,
                        type: 'sale',
                        reason: `Penjualan #${addedId}`
                    });
                }
                
                product.updatedAt = new Date().toISOString();
                await putToDB('products', product);
                
                const sanitizedProduct = {
                    id: product.id, serverId: product.serverId, name: product.name, price: product.price,
                    purchasePrice: product.purchasePrice, stock: product.stock, barcode: product.barcode,
                    category: product.category, discountPercentage: product.discountPercentage, image: product.image,
                    variations: product.variations || [], wholesalePrices: product.wholesalePrices || [],
                    createdAt: product.createdAt, updatedAt: product.updatedAt
                };
                await queueSyncAction('UPDATE_PRODUCT', sanitizedProduct);
            }
        }
        
        window.app.currentReceiptTransaction = { ...transaction, id: addedId };
        
        const autoPrint = await getFromDB('settings', 'autoPrintReceipt').then(s => s?.value);
        if (autoPrint && window.app.isPrinterReady) {
             if (window.printReceipt) {
                 window.printReceipt(true);
             }
        }

        showReceiptModal();
        
    } catch (error) {
        console.error("Transaction failed:", error);
        window.showToast('Transaksi gagal. Silakan coba lagi.');
    } finally {
        button.disabled = false;
        buttonText.classList.remove('hidden');
        spinner.classList.add('hidden');
    }
}

function showReceiptModal() {
    closePaymentModal();
    hideCartModal();
    (document.getElementById('receiptModal')).classList.remove('hidden');
    window.generateReceiptContent(window.app.currentReceiptTransaction);
    
    const actionButton = document.getElementById('receiptActionButton');
    actionButton.textContent = 'Transaksi Baru';
    actionButton.onclick = startNewTransaction;
}

export function startNewTransaction() {
    (document.getElementById('receiptModal')).classList.add('hidden');
    window.app.cart = { items: [], fees: [], customerId: null, customerName: null };
    applyDefaultFees();
    updateCartDisplay();
    loadProductsGrid();
    if(window.app.currentPage === 'dashboard') window.loadDashboard();
    window.app.currentReceiptTransaction = null;
    window.showToast('Siap untuk transaksi berikutnya.');
}

// --- PENDING TRANSACTIONS ---
export async function holdTransaction() {
    if (window.app.cart.items.length === 0) {
        window.showToast('Keranjang kosong, tidak ada yang bisa ditahan.');
        return;
    }

    const pendingTx = {
        cart: {
            items: window.app.cart.items,
            fees: window.app.cart.fees,
            customerId: window.app.cart.customerId,
            customerName: window.app.cart.customerName
        },
        timestamp: new Date().toISOString()
    };

    try {
        await putToDB('pending_transactions', pendingTx);
        
        window.app.cart = { items: [], fees: [], customerId: null, customerName: null };
        await applyDefaultFees();
        updateCartDisplay();
        hideCartModal();
        window.updatePendingBadge();
        
        window.showToast('Transaksi berhasil ditahan.');

    } catch (error) {
        console.error('Failed to hold transaction:', error);
        window.showToast('Gagal menahan transaksi.');
    }
}

export async function showPendingTransactionsModal() {
    const modal = document.getElementById('pendingTransactionsModal');
    const listEl = document.getElementById('pendingTransactionsList');
    if (!modal || !listEl) return;
    
    const pendingTxs = await getAllFromDB('pending_transactions');
    pendingTxs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (pendingTxs.length === 0) {
        listEl.innerHTML = `<p class="text-gray-500 text-center py-4">Tidak ada transaksi yang ditahan.</p>`;
    } else {
        listEl.innerHTML = pendingTxs.map(tx => {
            const time = new Date(tx.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
            const subtotal = tx.cart.items.reduce((sum, item) => sum + Math.round(item.effectivePrice * item.quantity), 0);
            let totalFees = 0;
            tx.cart.fees.forEach(fee => {
                const feeAmountRaw = fee.type === 'percentage' ? subtotal * (fee.value / 100) : fee.value;
                totalFees += Math.round(feeAmountRaw);
            });
            const total = subtotal + totalFees;

            return `
                <div class="card p-3">
                    <div class="flex justify-between items-center">
                        <div>
                            <p class="font-semibold">Disimpan pada ${time}</p>
                            <p class="text-sm text-gray-500">${tx.cart.items.length} item - Total Rp ${window.formatCurrency(total)}</p>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="deletePendingTransaction(${tx.id})" class="btn bg-red-100 text-red-700 px-3 py-1 text-xs">Hapus</button>
                            <button onclick="resumeTransaction(${tx.id})" class="btn bg-blue-500 text-white px-3 py-1 text-xs">Lanjutkan</button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    modal.classList.remove('hidden');
}

export function closePendingTransactionsModal() {
    const modal = document.getElementById('pendingTransactionsModal');
    if (modal) modal.classList.add('hidden');
}

async function proceedWithResume(id) {
    try {
        const pendingTx = await getFromDB('pending_transactions', id);
        if (!pendingTx) {
            window.showToast('Transaksi tertahan tidak ditemukan.');
            return;
        }

        window.app.cart.items = pendingTx.cart.items || [];
        window.app.cart.fees = pendingTx.cart.fees || [];
        window.app.cart.customerId = pendingTx.cart.customerId || null;
        window.app.cart.customerName = pendingTx.cart.customerName || null;

        const tx = window.app.db.transaction('pending_transactions', 'readwrite');
        tx.objectStore('pending_transactions').delete(id);
        await new Promise(resolve => tx.oncomplete = resolve);
        
        closePendingTransactionsModal();
        updateCartDisplay();
        showCartModal();
        window.updatePendingBadge();
        window.showToast('Transaksi berhasil dilanjutkan.');

    } catch (error) {
        console.error('Failed to resume transaction:', error);
        window.showToast('Gagal melanjutkan transaksi.');
    }
}

export async function resumeTransaction(id) {
    if (window.app.cart.items.length > 0) {
        window.showConfirmationModal(
            'Lanjutkan Transaksi?',
            'Keranjang saat ini berisi item. Melanjutkan akan mengganti isi keranjang saat ini. Lanjutkan?',
            async () => {
                await proceedWithResume(id);
            },
            'Ya, Ganti',
            'bg-yellow-500'
        );
    } else {
        await proceedWithResume(id);
    }
}

export function deletePendingTransaction(id) {
    window.showConfirmationModal(
        'Hapus Transaksi?',
        'Anda yakin ingin menghapus transaksi yang ditahan ini secara permanen?',
        async () => {
            try {
                const tx = window.app.db.transaction('pending_transactions', 'readwrite');
                tx.objectStore('pending_transactions').delete(id);
                await new Promise(resolve => tx.oncomplete = resolve);

                window.showToast('Transaksi tertahan dihapus.');
                window.updatePendingBadge();
                // Refresh list inside modal
                await showPendingTransactionsModal();
            } catch (error) {
                console.error('Failed to delete pending transaction:', error);
                window.showToast('Gagal menghapus transaksi.');
            }
        },
        'Ya, Hapus',
        'bg-red-500'
    );
}

// The actual search logic, not exported directly to window
async function performCustomerSearch(query) {
    const searchResultsEl = document.getElementById('customerSearchResults');
    if (!query || query.trim().length < 2) {
        searchResultsEl.innerHTML = '';
        searchResultsEl.classList.add('hidden');
        return;
    }

    const trimmedQuery = query.trim();
    const lowerCaseQuery = trimmedQuery.toLowerCase();

    try {
        const customers = await getAllFromDB('contacts', 'type', 'customer');
        
        // 1. Prioritize Exact Barcode Match for Auto-Selection
        const exactMatch = customers.find(c => c.barcode === trimmedQuery);
        
        if (exactMatch) {
            selectCustomer(exactMatch.id, exactMatch.name);
            window.showToast(`Pelanggan ditemukan: ${exactMatch.name}`);
            return;
        }

        // 2. Standard Fuzzy Search
        const results = customers.filter(c => 
            c.name.toLowerCase().includes(lowerCaseQuery) || 
            (c.phone && c.phone.includes(lowerCaseQuery)) ||
            (c.barcode && c.barcode.includes(lowerCaseQuery))
        );

        if (results.length > 0) {
            searchResultsEl.innerHTML = results.map(c => `
                <div class="p-3 hover:bg-gray-100 cursor-pointer border-b last:border-b-0" onclick="selectCustomer(${c.id}, '${c.name.replace(/'/g, "\\'")}')">
                    <p class="font-semibold">${c.name}</p>
                    <div class="flex items-center text-sm text-gray-500 gap-2">
                        <span>${c.phone || ''}</span>
                        ${c.barcode ? `<span class="text-xs bg-gray-100 px-1 rounded border"><i class="fas fa-barcode mr-1"></i>${c.barcode}</span>` : ''}
                    </div>
                </div>
            `).join('');
            searchResultsEl.classList.remove('hidden');
        } else {
            searchResultsEl.innerHTML = '<p class="p-3 text-gray-500 text-center text-sm">Pelanggan tidak ditemukan.</p>';
            searchResultsEl.classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error searching customers:', error);
        searchResultsEl.innerHTML = '<p class="p-3 text-red-500 text-sm">Gagal mencari.</p>';
        searchResultsEl.classList.remove('hidden');
    }
}

// --- Customer Search ---
// Debounced wrapper function that is called by the UI
export function searchCustomers(query) {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        performCustomerSearch(query);
    }, 300); // Wait for 300ms of inactivity before searching
}

export function selectCustomer(contactId, contactName) {
    window.app.cart.customerId = contactId;
    window.app.cart.customerName = contactName;

    document.getElementById('selectedCustomerName').textContent = contactName;
    document.getElementById('selectedCustomerDisplay').classList.remove('hidden');

    const searchContainer = document.getElementById('customerSearchContainer');
    searchContainer.classList.add('hidden');
    document.getElementById('customerSearchInput').value = '';
    document.getElementById('customerSearchResults').classList.add('hidden');
}

export function removeSelectedCustomer() {
    window.app.cart.customerId = null;
    window.app.cart.customerName = null;

    document.getElementById('selectedCustomerDisplay').classList.add('hidden');
    document.getElementById('selectedCustomerName').textContent = '';
    document.getElementById('customerSearchContainer').classList.remove('hidden');
}
