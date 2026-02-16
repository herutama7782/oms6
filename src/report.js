

import { getAllFromDB, getFromDB, putToDB, getSettingFromDB } from './db.js';
import { showToast, showConfirmationModal } from './ui.js';
import { queueSyncAction } from './sync.js';
import { formatCurrency } from './ui.js';
import { getLocalDateString } from './ui.js';
import { logStockChange } from './product.js';


// --- REPORTS ---
export async function generateReport() {
    const dateFrom = (document.getElementById('dateFrom')).value;
    const dateTo = (document.getElementById('dateTo')).value;
    const generateBtn = document.querySelector('#laporan button[onclick="generateReport()"]');
    const originalBtnContent = generateBtn.innerHTML;
    
    if (!dateFrom || !dateTo) {
        showToast('Silakan pilih rentang tanggal.');
        return;
    }
    
    // Show loading state
    generateBtn.disabled = true;
    generateBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Memuat Laporan...`;

    try {
        // Optimization: Use IndexedDB range query to fetch only transactions within the date range.
        const startDate = new Date(dateFrom + 'T00:00:00').toISOString();
        const endDate = new Date(dateTo + 'T23:59:59.999').toISOString();
        const range = IDBKeyRange.bound(startDate, endDate);

        // Fetch filtered transactions, ledgers, products, expenses, and contacts concurrently
        const [filteredTransactions, products, filteredLedgers, filteredExpenses, contacts] = await Promise.all([
            getAllFromDB('transactions', 'date', range),
            getAllFromDB('products'),
            getAllFromDB('ledgers', 'date', range),
            getAllFromDB('expenses', 'date', range),
            getAllFromDB('contacts')
        ]);
        
        window.app.currentReportData = filteredTransactions;
        window.app.currentReportLedgers = filteredLedgers;
        window.app.currentReportExpenses = filteredExpenses;

        if (filteredTransactions.length === 0 && filteredLedgers.length === 0 && filteredExpenses.length === 0) {
            showToast('Tidak ada transaksi, catatan, atau pengeluaran ditemukan pada rentang tanggal tersebut.');
            document.getElementById('reportSummary').style.display = 'none';
            document.getElementById('reportDetails').style.display = 'none';
            document.getElementById('topSellingProductsCard').style.display = 'none';
            return;
        }

        displayReportSummary(filteredTransactions, products, filteredLedgers, filteredExpenses, contacts);
        displayReportDetails(filteredTransactions);
        displayTopSellingProducts(filteredTransactions);

        document.getElementById('reportSummary').style.display = 'block';
        document.getElementById('reportDetails').style.display = 'block';
        document.getElementById('topSellingProductsCard').style.display = 'block';
    } catch (error) {
        console.error("Failed to generate report:", error);
        showToast('Gagal membuat laporan. Coba lagi.');
    } finally {
        // Restore button state
        generateBtn.disabled = false;
        generateBtn.innerHTML = originalBtnContent;
    }
}


function displayReportSummary(transactions, products, ledgers = [], expenses = [], contacts = []) {
    const productMap = new Map(products.map(p => [p.id, p]));

    let omzet = 0;
    let hpp = 0;
    let totalTransactionFees = 0; // Renamed from totalOperationalCost
    let totalDiskon = 0;
    let totalPenjualanGrosir = 0;
    let totalDonasi = 0;

    transactions.forEach(t => {
        const subtotalAfterDiscount = t.total - (t.fees || []).reduce((sum, fee) => sum + fee.amount, 0);
        omzet += subtotalAfterDiscount;

        totalDiskon += t.totalDiscount || 0;
        totalDonasi += t.donation || 0;

        t.items.forEach(item => {
            const productId = item.productId || item.id;
            const product = productMap.get(productId);
            const purchasePrice = product ? (product.purchasePrice || 0) : 0;
            hpp += purchasePrice * item.quantity;
            
            if (item.isWholesale) {
                totalPenjualanGrosir += item.effectivePrice * item.quantity;
            }
        });
        
        (t.fees || []).forEach(fee => {
            totalTransactionFees += fee.amount;
        });
    });

    // Calculate Manual Expenses
    let totalManualExpenses = 0;
    expenses.forEach(e => {
        totalManualExpenses += e.amount;
    });

    // Calculate Ledger Totals (Receivable Payments & Debt Payments)
    const contactMap = new Map(contacts.map(c => [c.id, c]));
    let totalReceivablePayments = 0;
    let totalDebtPayments = 0;

    ledgers.forEach(l => {
        const contact = contactMap.get(l.contactId);
        if (!contact) return;
        
        // Assuming 'credit' means payment (reducing balance)
        if (l.type === 'credit') {
            if (contact.type === 'customer') {
                totalReceivablePayments += l.amount;
            } else if (contact.type === 'supplier') {
                totalDebtPayments += l.amount;
            }
        }
    });

    const grossProfit = omzet - hpp; // Laba Kotor Penjualan
    // True Net Profit = Gross Profit - Transaction Fees - Manual Expenses
    const netProfit = grossProfit - totalTransactionFees - totalManualExpenses;
    
    // "Estimasi Kas Masuk Bersih" = Net Profit + Receivable Payments - Debt Payments
    // This is a simplified cash flow estimation based on what flowed in vs out.
    // Note: Manual Expenses are cash out, so they are already subtracted in netProfit.
    const cashFlow = netProfit + totalReceivablePayments - totalDebtPayments;
    
    const totalTransactions = transactions.length;
    const average = totalTransactions > 0 ? omzet / totalTransactions : 0;

    (document.getElementById('reportOmzet')).textContent = `Rp ${formatCurrency(omzet)}`;
    (document.getElementById('reportTotalDonation')).textContent = `Rp ${formatCurrency(totalDonasi)}`;
    (document.getElementById('reportWholesaleSales')).textContent = `Rp ${formatCurrency(totalPenjualanGrosir)}`;
    (document.getElementById('reportTotalDiscount')).textContent = `Rp ${formatCurrency(totalDiskon)}`;
    (document.getElementById('reportHpp')).textContent = `Rp ${formatCurrency(hpp)}`;
    (document.getElementById('reportGrossProfit')).textContent = `Rp ${formatCurrency(grossProfit)}`;
    (document.getElementById('reportOperationalCost')).textContent = `Rp ${formatCurrency(totalTransactionFees)}`;
    (document.getElementById('reportManualExpenses')).textContent = `Rp ${formatCurrency(totalManualExpenses)}`;
    (document.getElementById('reportNetProfit')).textContent = `Rp ${formatCurrency(netProfit)}`;
    
    (document.getElementById('reportReceivablePayments')).textContent = `Rp ${formatCurrency(totalReceivablePayments)}`;
    (document.getElementById('reportDebtPayments')).textContent = `Rp ${formatCurrency(totalDebtPayments)}`;
    
    (document.getElementById('reportCashFlow')).textContent = `Rp ${formatCurrency(cashFlow)}`;
    (document.getElementById('reportTotalTransactions')).textContent = totalTransactions.toString();
    (document.getElementById('reportAverage')).textContent = `Rp ${formatCurrency(average)}`;
}

function displayReportDetails(transactions) {
    const detailsEl = document.getElementById('reportTransactions');
    detailsEl.innerHTML = transactions.sort((a,b) => new Date(b.date) - new Date(a.date)).map(t => {
        const date = new Date(t.date);
        const formattedDate = `${date.toLocaleDateString('id-ID')} ${date.toLocaleTimeString('id-ID')}`;
        const paymentMethod = t.paymentMethod || 'TUNAI';
        return `
            <div class="border-t pt-2 mt-2">
                <div class="flex justify-between text-sm">
                    <div>
                        <span>${formattedDate}</span>
                        <span class="ml-2 px-2 py-0.5 rounded-full text-xs ${paymentMethod === 'QRIS' ? 'bg-purple-100 text-purple-800' : 'bg-green-100 text-green-800'}">${paymentMethod}</span>
                    </div>
                    <span class="font-semibold">Rp ${formatCurrency(t.total)}</span>
                </div>
                 <p class="text-xs text-gray-500">Kasir: ${t.userName || 'N/A'}</p>
                <ul class="text-xs text-gray-600 pl-4 mt-1 space-y-1">
                    ${t.items.map((item, index) => `
                        <li class="flex justify-between items-center">
                            <span>${item.quantity}x ${item.name} &mdash; Rp ${formatCurrency(item.effectivePrice * item.quantity)}</span>
                            <button onclick="returnItem(${t.id}, ${index})" title="Kembalikan item ini" class="text-red-500 hover:text-red-700 clickable text-sm w-6 h-6 rounded-full flex items-center justify-center hover:bg-red-100 transition-colors">
                                <i class="fas fa-undo"></i>
                            </button>
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;
    }).join('');
}

export async function returnItem(transactionId, itemIndex) {
    try {
        const transaction = await getFromDB('transactions', transactionId);
        if (!transaction || !transaction.items[itemIndex]) {
            showToast('Item atau transaksi tidak ditemukan.');
            return;
        }

        const item = transaction.items[itemIndex];

        showConfirmationModal(
            'Konfirmasi Pengembalian',
            `Anda yakin ingin mengembalikan <strong>${item.quantity}x ${item.name}</strong> senilai <strong>Rp ${formatCurrency(item.effectivePrice * item.quantity)}</strong>? Stok produk akan dikembalikan dan laporan akan diperbarui.`,
            async () => {
                await processItemReturn(transactionId, itemIndex);
            },
            'Ya, Kembalikan',
            'bg-red-500'
        );
    } catch (error) {
        console.error('Error preparing item return:', error);
        showToast('Gagal memproses pengembalian.');
    }
}

async function processItemReturn(transactionId, itemIndex) {
    try {
        const originalTransaction = await getFromDB('transactions', transactionId);
        if (!originalTransaction) {
            showToast('Transaksi tidak valid saat proses.');
            return;
        }
        
        // Deep-copy and polyfill items to prevent data corruption from old transaction formats.
        const transaction = {
            ...originalTransaction,
            items: (originalTransaction.items || []).map(item => {
                const newItem = { ...item };

                // Polyfill 'basePrice' for older transactions where it was just 'price' (pre-discount)
                newItem.basePrice = item.basePrice !== undefined ? item.basePrice : item.price;

                // Polyfill 'effectivePrice' for older transactions to prevent NaN errors
                if (item.effectivePrice === undefined) {
                    let initialPrice = newItem.basePrice;
                    let discountValue = 0;
                    let discountType = 'percentage'; // Default to percentage for old `discountPercentage` field

                    if (item.discount && typeof item.discount === 'object' && item.discount.value > 0) {
                        discountValue = item.discount.value;
                        discountType = item.discount.type;
                    } else if (item.discountPercentage > 0) {
                        discountValue = item.discountPercentage;
                        discountType = 'percentage';
                    }

                    if (discountType === 'percentage') {
                        newItem.effectivePrice = initialPrice * (1 - discountValue / 100);
                    } else { // fixed
                        newItem.effectivePrice = Math.max(0, initialPrice - discountValue);
                    }
                }
                
                newItem.isWholesale = item.isWholesale || false;
                return newItem;
            }),
            fees: (originalTransaction.fees || []).map(fee => ({ ...fee }))
        };


        const [returnedItem] = transaction.items.splice(itemIndex, 1);
        if (!returnedItem) {
             showToast('Item tidak ditemukan dalam transaksi.');
             return;
        }
        
        if (transaction.items.length === 0) {
             const tx = window.app.db.transaction('transactions', 'readwrite');
             tx.objectStore('transactions').delete(transactionId);
             await new Promise(resolve => tx.oncomplete = resolve);
             await queueSyncAction('DELETE_TRANSACTION', transaction);
        } else {
            transaction.subtotal = transaction.items.reduce((sum, item) => sum + (item.basePrice * item.quantity), 0);
            transaction.totalDiscount = transaction.items.reduce((sum, item) => {
                 return sum + ((item.basePrice - item.effectivePrice) * item.quantity);
            }, 0);
            
            const subtotalAfterDiscount = transaction.subtotal - transaction.totalDiscount;
            let totalFeeAmount = 0;

            (transaction.fees || []).forEach(fee => {
                if (fee.type === 'percentage') {
                    fee.amount = Math.round(subtotalAfterDiscount * (fee.value / 100));
                }
                totalFeeAmount += fee.amount;
            });
            
            transaction.total = subtotalAfterDiscount + totalFeeAmount;
            transaction.change = transaction.cashPaid - transaction.total;
            
            await putToDB('transactions', transaction);
            await queueSyncAction('UPDATE_TRANSACTION', transaction);
        }

        const productIdToUpdate = returnedItem.productId || returnedItem.id;
        const product = await getFromDB('products', productIdToUpdate);

        if (product) {
            const oldStock = product.stock;
            let newStock = oldStock;
            let variationName = null;

            if (product.stock === null) {
                // Do not restock for unlimited stock items
            } else if (returnedItem.variationIndex !== undefined && product.variations && product.variations[returnedItem.variationIndex]) {
                const oldVarStock = product.variations[returnedItem.variationIndex].stock || 0;
                product.variations[returnedItem.variationIndex].stock += returnedItem.quantity;
                newStock = product.variations.reduce((total, v) => total + (v.stock || 0), 0);
                variationName = product.variations[returnedItem.variationIndex].name;
                
                await logStockChange({
                    productId: product.id,
                    productName: product.name,
                    variationName: variationName,
                    oldStock: oldVarStock,
                    newStock: product.variations[returnedItem.variationIndex].stock,
                    type: 'return',
                    reason: `Retur Transaksi #${transactionId}`
                });

            } else {
                product.stock += returnedItem.quantity;
                newStock = product.stock;
                
                await logStockChange({
                    productId: product.id,
                    productName: product.name,
                    oldStock: oldStock,
                    newStock: newStock,
                    type: 'return',
                    reason: `Retur Transaksi #${transactionId}`
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

        showToast('Item berhasil dikembalikan.');
        await generateReport();

    } catch (error) {
        console.error('Failed to process item return:', error);
        showToast('Terjadi kesalahan saat mengembalikan item.');
    }
}


function displayTopSellingProducts(transactions) {
    const productSales = {};

    transactions.forEach(t => {
        t.items.forEach(item => {
            if (!productSales[item.name]) {
                productSales[item.name] = { quantity: 0, revenue: 0 };
            }
            productSales[item.name].quantity += item.quantity;
            productSales[item.name].revenue += item.effectivePrice * item.quantity;
        });
    });

    const sortedProducts = Object.entries(productSales)
        .sort(([,a], [,b]) => b.quantity - a.quantity)
        .slice(0, 5);
    
    const listEl = document.getElementById('topSellingProductsList');
    if (sortedProducts.length === 0) {
        listEl.innerHTML = `<p class="text-gray-500 text-center py-2">Tidak ada produk terjual.</p>`;
        return;
    }

    listEl.innerHTML = sortedProducts.map(([name, data], index) => `
        <div class="flex justify-between items-center text-sm">
            <span>${index + 1}. ${name}</span>
            <div class="text-right">
                <span class="font-semibold">${data.quantity} terjual</span>
                <p class="text-xs text-gray-500">Rp ${formatCurrency(data.revenue)}</p>
            </div>
        </div>
    `).join('');
}


export function displaySalesReport(transactions, viewType) {
    if (!window.app.isChartJsReady || !Chart) {
        document.getElementById('salesChartCard').innerHTML = `<p class="text-center text-red-500">Grafik tidak dapat dimuat.</p>`;
        return;
    }
    
    const salesData = {};
    const getWeek = (d) => {
        const date = new Date(d.getTime());
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
        const week1 = new Date(date.getFullYear(), 0, 4);
        return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    };

    transactions.forEach(t => {
        const date = new Date(t.date);
        let key;

        if (viewType === 'daily') {
            key = date.toISOString().split('T')[0];
        } else {
            key = `${date.getFullYear()}-W${getWeek(date)}`;
        }

        if (!salesData[key]) {
            salesData[key] = 0;
        }
        salesData[key] += t.total;
    });

    const sortedLabels = Object.keys(salesData).sort();
    const dataPoints = sortedLabels.map(label => salesData[label]);
    
    const canvas = document.getElementById('salesChart');
    const ctx = canvas.getContext('2d');
    
    // Create dynamic gradient for filled area
    const chartHeight = canvas.offsetHeight || 250;
    const gradient = ctx.createLinearGradient(0, 0, 0, chartHeight);
    gradient.addColorStop(0, 'rgba(59, 130, 246, 0.45)');
    gradient.addColorStop(1, 'rgba(59, 130, 246, 0.05)');

    if (window.app.salesChartInstance) {
        window.app.salesChartInstance.destroy();
    }
    
    window.app.salesChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: sortedLabels,
            datasets: [{
                label: 'Total Penjualan',
                data: dataPoints,
                borderColor: '#3b82f6',
                borderWidth: 3,
                backgroundColor: gradient,
                fill: true,
                tension: 0.45, // Enhanced Bézier Curve Smoothing
                pointRadius: 0, // Hide dots by default for cleaner look
                pointHoverRadius: 6, // Show on hover
                pointBackgroundColor: '#3b82f6',
                pointBorderColor: '#fff',
                pointBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index',
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        display: true,
                        color: 'rgba(0, 0, 0, 0.05)',
                        drawBorder: false
                    },
                    ticks: {
                        callback: function(value, index, values) {
                            return 'Rp ' + (value / 1000) + 'k';
                        },
                        font: { size: 10 }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 10 } }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(255, 255, 255, 0.95)',
                    titleColor: '#1f2937',
                    bodyColor: '#1f2937',
                    borderColor: '#e5e7eb',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: function(context) {
                            let label = '';
                            if (context.parsed.y !== null) {
                                label += new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(context.parsed.y);
                            }
                            return label;
                        }
                    }
                }
            }
        }
    });
}


export function setupChartViewToggle() {
    const dailyBtn = document.getElementById('dailyViewBtn');
    const weeklyBtn = document.getElementById('weeklyViewBtn');
    const glider = document.getElementById('chartViewGlider');

    if (!dailyBtn || !weeklyBtn || !glider) return;

    dailyBtn.addEventListener('click', () => {
        glider.style.transform = 'translateX(0%)';
        dailyBtn.classList.remove('text-gray-500');
        dailyBtn.classList.add('text-gray-800');
        weeklyBtn.classList.add('text-gray-500');
        weeklyBtn.classList.remove('text-gray-800');
        displaySalesReport(window.app.dashboardTransactions, 'daily');
    });

    weeklyBtn.addEventListener('click', () => {
        glider.style.transform = 'translateX(100%)';
        weeklyBtn.classList.remove('text-gray-500');
        weeklyBtn.classList.add('text-gray-800');
        dailyBtn.classList.add('text-gray-500');
        dailyBtn.classList.remove('text-gray-800');
        displaySalesReport(window.app.dashboardTransactions, 'weekly');
    });
}


export async function exportReportToCSV() {
    if (window.app.currentReportData.length === 0 && (!window.app.currentReportExpenses || window.app.currentReportExpenses.length === 0)) {
        showToast('Tidak ada data untuk diexport.');
        return;
    }

    try {
        const allProducts = await getAllFromDB('products');
        const productMap = new Map(allProducts.map(p => [p.id, p]));

        // --- CALCULATION PHASE ---
        let omzet = 0, hpp = 0, totalTransactionFees = 0, totalDiskon = 0,
            totalPenjualanGrosir = 0, totalDonasi = 0, totalReceivedCash = 0,
            totalReceivedQris = 0, totalChange = 0;

        window.app.currentReportData.forEach(t => {
            const subtotalAfterDiscount = t.total - (t.fees || []).reduce((sum, fee) => sum + fee.amount, 0);
            omzet += subtotalAfterDiscount;
            totalDiskon += t.totalDiscount || 0;
            totalDonasi += t.donation || 0;

            if (t.paymentMethod === 'QRIS') {
                totalReceivedQris += t.grandTotal || t.total;
            } else { 
                totalReceivedCash += t.cashPaid;
                // FIX: Only subtract positive change. Negative change means Debt (Piutang)
                if (t.change > 0) {
                    totalChange += t.change;
                }
            }

            t.items.forEach(item => {
                const productId = item.productId || item.id;
                const product = productMap.get(productId);
                const purchasePrice = product ? (product.purchasePrice || 0) : 0;
                hpp += purchasePrice * item.quantity;
                if (item.isWholesale) {
                    totalPenjualanGrosir += item.effectivePrice * item.quantity;
                }
            });
            (t.fees || []).forEach(fee => {
                totalTransactionFees += fee.amount;
            });
        });
        
        // Expenses
        let totalManualExpenses = 0;
        const expenses = window.app.currentReportExpenses || [];
        expenses.forEach(e => totalManualExpenses += e.amount);

        const grossProfit = omzet - hpp;
        const netProfit = grossProfit - totalTransactionFees - totalManualExpenses;
        const cashInDrawer = totalReceivedCash - totalChange;
        
        let totalInventoryCost = 0;
        let totalInventoryValue = 0;
        allProducts.forEach(p => {
            if (p.variations && p.variations.length > 0) {
                p.variations.forEach(v => {
                    if (v.stock !== null) {
                        totalInventoryCost += (v.purchasePrice || 0) * v.stock;
                        totalInventoryValue += (v.price || 0) * v.stock;
                    }
                });
            } else {
                if (p.stock !== null) {
                    totalInventoryCost += (p.purchasePrice || 0) * p.stock;
                    totalInventoryValue += (p.price || 0) * p.stock;
                }
            }
        });
        
        const contacts = await getAllFromDB('contacts');
        const ledgers = await getAllFromDB('ledgers');
        const balanceMap = new Map();
        ledgers.forEach(entry => {
            const currentBalance = balanceMap.get(entry.contactId) || 0;
            balanceMap.set(entry.contactId, currentBalance + (entry.type === 'debit' ? entry.amount : -entry.amount));
        });

        // --- CSV STRING GENERATION ---
        const escapeCSV = (val) => {
            if (val === null || val === undefined) return '';
            let str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
        };

        let csvContent = "";
        const dateFrom = document.getElementById('dateFrom').value;
        const dateTo = document.getElementById('dateTo').value;

        // SECTION 1: Summary
        csvContent += "Ringkasan Laporan\n";
        csvContent += `Periode,"${dateFrom} s/d ${dateTo}"\n\n`;
        csvContent += `Total Omzet (Penjualan Bersih),${omzet}\n`;
        csvContent += `Total Donasi Terkumpul,${totalDonasi}\n`;
        csvContent += `(Termasuk Penjualan Grosir),${totalPenjualanGrosir}\n`;
        csvContent += `Total Diskon Diberikan,${totalDiskon}\n`;
        csvContent += `(-) Total Harga Pokok Penjualan (HPP),${hpp}\n`;
        csvContent += `Laba Kotor,${grossProfit}\n`;
        csvContent += `(-) Total Biaya Transaksi & Layanan,${totalTransactionFees}\n`;
        csvContent += `(-) Total Pengeluaran Operasional Toko,${totalManualExpenses}\n`;
        csvContent += `Laba Bersih Usaha,${netProfit}\n\n`;
        csvContent += `Total Diterima (Tunai),${totalReceivedCash}\n`;
        csvContent += `Total Diterima (QRIS),${totalReceivedQris}\n`;
        csvContent += `(-) Total Kembalian (Tunai),${totalChange}\n`;
        csvContent += `Uang Tunai di Laci (Perkiraan),${cashInDrawer}\n\n`;
        csvContent += `Nilai Total Inventaris (Harga Beli),${totalInventoryCost}\n`;
        csvContent += `Nilai Total Inventaris (Harga Jual),${totalInventoryValue}\n\n\n`;

        // SECTION 2: Expense Details (New)
        if (expenses.length > 0) {
            csvContent += "Rincian Pengeluaran Toko\n";
            csvContent += "Tanggal,Nama Pengeluaran,Kategori,Jumlah,Keterangan\n";
            expenses.sort((a,b) => new Date(a.date) - new Date(b.date)).forEach(e => {
                const date = new Date(e.date).toLocaleDateString('id-ID');
                csvContent += [date, e.name, e.category || '-', e.amount, e.description || '-'].map(escapeCSV).join(',') + '\n';
            });
            csvContent += "\n\n";
        }

        // SECTION 3: Ledger Report
        csvContent += "Laporan Hutang & Piutang\n";
        csvContent += "Tipe,Nama Kontak,No. HP,Total Piutang/Hutang\n";
        contacts.forEach(c => {
            const balance = balanceMap.get(c.id) || 0;
            if (balance !== 0) {
                const type = c.type === 'customer' ? 'Piutang' : 'Hutang';
                const row = [type, c.name, c.phone || '-', balance].map(escapeCSV).join(',');
                csvContent += row + '\n';
            }
        });
        csvContent += "\n\n";

        // SECTION 4: Top Selling Products
        const productSales = {};
        window.app.currentReportData.forEach(t => t.items.forEach(item => {
            const name = item.name;
            if (!productSales[name]) productSales[name] = { quantity: 0, revenue: 0 };
            productSales[name].quantity += item.quantity;
            productSales[name].revenue += item.effectivePrice * item.quantity;
        }));
        const sortedProducts = Object.entries(productSales).sort(([, a], [, b]) => b.quantity - a.quantity);
        if (sortedProducts.length > 0) {
            csvContent += "Produk Terlaris\n";
            csvContent += "Peringkat,Nama Produk,Jumlah Terjual,Total Pendapatan\n";
            sortedProducts.forEach(([name, data], index) => {
                csvContent += [index + 1, name, data.quantity, data.revenue].map(escapeCSV).join(',') + '\n';
            });
        }
        csvContent += "\n\n";

        // SECTION 5: Detailed Transactions
        csvContent += "Detail Transaksi\n";
        csvContent += "ID Transaksi,Tanggal,Metode Pembayaran,Donasi Transaksi,Nama Kasir,Nama Produk,Kategori,Jumlah,Harga Asli (Satuan),Tipe Harga,Harga Sebelum Diskon (Satuan),Total Diskon Item,Harga Final (Satuan),Total Omzet Item,Harga Beli (Satuan),Total HPP Item,Laba Item\n";
        window.app.currentReportData.forEach(t => {
            t.items.forEach(item => {
                const product = productMap.get(item.productId || item.id);
                const purchasePrice = product ? (product.purchasePrice || 0) : 0;
                const totalOmzetItem = item.effectivePrice * item.quantity;
                const row = [
                    t.id, new Date(t.date).toLocaleString('id-ID'), t.paymentMethod || 'TUNAI', t.donation || 0,
                    t.userName || 'N/A', item.name, product ? product.category : 'N/A', item.quantity,
                    item.price, item.isWholesale ? 'Grosir' : 'Normal', item.basePrice || item.price,
                    (item.basePrice - item.effectivePrice) * item.quantity, item.effectivePrice, totalOmzetItem,
                    purchasePrice, purchasePrice * item.quantity, totalOmzetItem - (purchasePrice * item.quantity)
                ].map(escapeCSV).join(',');
                csvContent += row + '\n';
            });
        });
        csvContent += "\n\n";

        // SECTION 6: Stock Opname List
        const soldQuantities = new Map();
        window.app.currentReportData.forEach(t => t.items.forEach(item => {
            soldQuantities.set(item.id, (soldQuantities.get(item.id) || 0) + item.quantity);
        }));
        csvContent += "Daftar Stok Produk (untuk Stok Opname)\n";
        csvContent += "ID Produk/Variasi,Barcode,Nama Produk,Nama Variasi,Kategori,Stok Awal (Kalkulasi),Stok Sistem,Stok Fisik (isi manual),Selisih\n";
        allProducts.sort((a, b) => a.name.localeCompare(b.name)).forEach(p => {
            if (p.variations && p.variations.length > 0) {
                p.variations.forEach((v, index) => {
                    const id = `${p.id}-${index}`;
                    const currentStock = v.stock;
                    const soldQty = soldQuantities.get(id) || 0;
                    const initialStock = currentStock === null ? 'Tak Terbatas' : currentStock + soldQty;
                    csvContent += [id, p.barcode || '', p.name, v.name, p.category || '', initialStock, currentStock === null ? 'Tak Terbatas' : currentStock, '', ''].map(escapeCSV).join(',') + '\n';
                });
            } else {
                const currentStock = p.stock;
                const soldQty = soldQuantities.get(p.id) || 0;
                const initialStock = currentStock === null ? 'Tak Terbatas' : currentStock + soldQty;
                csvContent += [p.id, p.barcode || '', p.name, '', p.category || '', initialStock, currentStock === null ? 'Tak Terbatas' : currentStock, '', ''].map(escapeCSV).join(',') + '\n';
            }
        });

        // --- FILE DOWNLOAD ---
        const fileName = `laporan_penjualan_${dateFrom}_sd_${dateTo}.csv`;
        if (window.AndroidDownloader) {
            window.AndroidDownloader.downloadFile(csvContent, fileName, 'text/csv');
        } else {
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", fileName);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }
        showToast('Export laporan berhasil.');
    } catch (error) {
        console.error('Export report failed:', error);
        showToast('Gagal mengexport data.');
    }
}

// --- EXPENSE MANAGEMENT ---

export async function showExpenseModal() {
    await loadExpensesForModal();
    document.getElementById('expenseListModal').classList.remove('hidden');
}

export function closeExpenseModal() {
    document.getElementById('expenseListModal').classList.add('hidden');
}

export function showExpenseFormModal(expenseId = null) {
    document.getElementById('expenseId').value = expenseId || '';
    document.getElementById('expenseDate').value = getLocalDateString(new Date());
    document.getElementById('expenseName').value = '';
    document.getElementById('expenseAmount').value = '';
    document.getElementById('expenseCategory').value = 'Operasional';
    document.getElementById('expenseDescription').value = '';
    
    document.getElementById('expenseFormTitle').textContent = expenseId ? 'Edit Pengeluaran' : 'Tambah Pengeluaran';

    if (expenseId) {
        // Fetch existing data
        getFromDB('expenses', expenseId).then(expense => {
            if (expense) {
                document.getElementById('expenseDate').value = getLocalDateString(new Date(expense.date));
                document.getElementById('expenseName').value = expense.name;
                document.getElementById('expenseAmount').value = expense.amount;
                document.getElementById('expenseCategory').value = expense.category || 'Operasional';
                document.getElementById('expenseDescription').value = expense.description || '';
            }
        });
    }

    closeExpenseModal(); // Close list modal
    document.getElementById('expenseFormModal').classList.remove('hidden');
}

export function closeExpenseFormModal() {
    document.getElementById('expenseFormModal').classList.add('hidden');
    // Re-open list modal
    showExpenseModal();
}

async function loadExpensesForModal() {
    const listEl = document.getElementById('expenseList');
    try {
        const expenses = await getAllFromDB('expenses');
        if (expenses.length === 0) {
            listEl.innerHTML = `<p class="text-gray-500 text-center py-4">Belum ada catatan pengeluaran.</p>`;
            return;
        }

        // Sort by date descending
        expenses.sort((a, b) => new Date(b.date) - new Date(a.date));

        listEl.innerHTML = expenses.map(e => `
            <div class="flex justify-between items-center bg-gray-50 p-3 rounded-lg border">
                <div>
                    <p class="font-semibold">${e.name}</p>
                    <p class="text-xs text-gray-500">${new Date(e.date).toLocaleDateString('id-ID')} - ${e.category || 'Umum'}</p>
                </div>
                <div class="text-right flex items-center gap-2">
                    <span class="font-bold text-red-600 mr-2">Rp ${formatCurrency(e.amount)}</span>
                    <button onclick="showExpenseFormModal(${e.id})" class="text-blue-500 clickable"><i class="fas fa-edit"></i></button>
                    <button onclick="deleteExpense(${e.id})" class="text-red-500 clickable"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error("Error loading expenses", e);
    }
}

export async function saveExpense() {
    const id = document.getElementById('expenseId').value ? parseInt(document.getElementById('expenseId').value) : null;
    const dateVal = document.getElementById('expenseDate').value;
    const name = document.getElementById('expenseName').value.trim();
    const amount = parseFloat(document.getElementById('expenseAmount').value);
    const category = document.getElementById('expenseCategory').value;
    const description = document.getElementById('expenseDescription').value.trim();

    if (!dateVal || !name || isNaN(amount) || amount <= 0) {
        showToast('Mohon lengkapi data wajib (Tanggal, Nama, Jumlah)');
        return;
    }

    const expense = {
        date: new Date(dateVal).toISOString(),
        name,
        amount,
        category,
        description,
        updatedAt: new Date().toISOString()
    };

    try {
        if (id) {
            expense.id = id;
            // Keep original createdAt
            const old = await getFromDB('expenses', id);
            if(old) expense.createdAt = old.createdAt;
            
            await putToDB('expenses', expense);
            await queueSyncAction('UPDATE_EXPENSE', expense);
            showToast('Pengeluaran diperbarui');
        } else {
            expense.createdAt = new Date().toISOString();
            const newId = await putToDB('expenses', expense);
            await queueSyncAction('CREATE_EXPENSE', { ...expense, id: newId });
            showToast('Pengeluaran ditambahkan');
        }
        closeExpenseFormModal();
    } catch (e) {
        console.error("Error saving expense", e);
        showToast('Gagal menyimpan');
    }
}

export function deleteExpense(id) {
    showConfirmationModal('Hapus Pengeluaran', 'Yakin ingin menghapus catatan ini?', async () => {
        try {
            const expense = await getFromDB('expenses', id);
            const tx = window.app.db.transaction('expenses', 'readwrite');
            tx.objectStore('expenses').delete(id);
            tx.oncomplete = async () => {
                await queueSyncAction('DELETE_EXPENSE', expense || { id });
                showToast('Dihapus');
                loadExpensesForModal();
            };
        } catch (e) {
            console.error("Error deleting expense", e);
        }
    }, 'Ya, Hapus', 'bg-red-500');
}


// --- CASHIER DAILY REPORT ---
export async function generateCashierReport(btnElement) {
    let generateBtn = btnElement;
    // Fallback logic in case btnElement is not passed correctly (e.g. legacy calls)
    if (!generateBtn) {
        // Try to find it in the current view.
        // We know 'cashierReportView' is for cashier role, and we added a new button in 'adminReportView'.
        // Check which view is likely active or check both IDs.
        generateBtn = document.querySelector('#cashierReportView button[onclick^="generateCashierReport"]') ||
                      document.querySelector('#adminReportView button[onclick^="generateCashierReport"]');
    }

    let originalBtnContent = '';
    if (generateBtn) {
        originalBtnContent = generateBtn.innerHTML;
        generateBtn.disabled = true;
        generateBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>Memuat Laporan...`;
    }
    
    try {
        const currentUser = window.app.currentUser;
        if (!currentUser) {
            showToast('Pengguna tidak ditemukan.');
            return;
        }

        const todayString = getLocalDateString(new Date());
        const startDate = new Date(todayString + 'T00:00:00').toISOString();
        const endDate = new Date(todayString + 'T23:59:59.999').toISOString();
        const range = IDBKeyRange.bound(startDate, endDate);

        const [allTodayTransactions, allTodayLedgers, allContacts] = await Promise.all([
            getAllFromDB('transactions', 'date', range),
            getAllFromDB('ledgers', 'date', range),
            getAllFromDB('contacts')
        ]);

        const cashierTransactions = allTodayTransactions.filter(t => t.userId === currentUser.id);

        if (cashierTransactions.length === 0 && allTodayLedgers.length === 0) {
            showToast('Belum ada data transaksi atau kas untuk hari ini.');
            // We continue to show empty report if they insist, or just return.
            // Let's just return for now if truly nothing happened.
            if (cashierTransactions.length === 0) { 
                 showToast('Anda belum memiliki transaksi hari ini.');
                 return; 
            }
        }

        // --- CALCULATIONS ---
        let totalOmzet = 0;
        let totalReceivedCash = 0;
        let totalReceivedQris = 0;
        let totalChange = 0;
        let totalDonasi = 0;
        let totalNewReceivables = 0;
        const productSales = new Map();
        const feeSummary = new Map();

        cashierTransactions.forEach(t => {
            totalOmzet += t.total;
            totalDonasi += t.donation || 0;

            if (t.paymentMethod === 'QRIS') {
                totalReceivedQris += t.grandTotal || t.total;
            } else { 
                // For Cash or Debt/Piutang
                totalReceivedCash += t.cashPaid;
                
                // Check for Debt (Piutang) transaction indicated by negative change
                if (t.change < 0) {
                    // This is the unpaid amount (Receivable)
                    totalNewReceivables += Math.abs(t.change);
                } else {
                    // Normal cash transaction
                    totalChange += t.change;
                }
            }

            t.items.forEach(item => {
                const existing = productSales.get(item.name) || { quantity: 0, total: 0 };
                existing.quantity += item.quantity;
                existing.total += item.effectivePrice * item.quantity;
                productSales.set(item.name, existing);
            });

            (t.fees || []).forEach(fee => {
                const existingFee = feeSummary.get(fee.name) || { amount: 0 };
                existingFee.amount += fee.amount;
                feeSummary.set(fee.name, existingFee);
            });
        });

        // Process Ledgers for Cashier Report (Receivable Collections & Debt Payments)
        const contactMap = new Map(allContacts.map(c => [c.id, c]));
        const receivableCollections = [];
        let totalReceivableCollected = 0;
        let totalDebtPaid = 0; // New: Track money going OUT for supplier payments

        allTodayLedgers.forEach(l => {
            // Filter ledgers by the current cashier to ensure accurate "Cash In Hand" for THIS drawer.
            // If userId is missing (legacy data), we might want to include it or skip.
            // Strict approach: Only include if it matches current user.
            if (l.userId === currentUser.id) {
                const contact = contactMap.get(l.contactId);
                if (!contact) return;

                // Incoming Money: Customer paying debt (Credit on Customer Account)
                if (contact.type === 'customer' && l.type === 'credit') {
                    receivableCollections.push({
                        name: contact.name,
                        amount: l.amount,
                        description: l.description,
                        type: 'receivable'
                    });
                    totalReceivableCollected += l.amount;
                }
                // Outgoing Money: Store paying supplier debt (Credit on Supplier Account)
                // Assuming 'credit' on supplier means we paid them, reducing our debt.
                else if (contact.type === 'supplier' && l.type === 'credit') {
                     receivableCollections.push({
                        name: contact.name,
                        amount: l.amount,
                        description: l.description,
                        type: 'debt_payment'
                    });
                    totalDebtPaid += l.amount;
                }
            }
        });

        // Cash In Hand = (Sales Cash - Change) + Receivable Collections - Debt Payments
        // Note: totalChange now only contains positive values (real change given out)
        const cashInHand = (totalReceivedCash - totalChange) + totalReceivableCollected - totalDebtPaid;

        const reportData = {
            cashierName: currentUser.name,
            reportDate: new Date().toISOString(),
            transactions: cashierTransactions,
            summary: {
                totalOmzet,
                totalReceivedCash,
                totalReceivedQris,
                totalChange,
                totalDonasi,
                totalNewReceivables, // Add this field
                totalTransactions: cashierTransactions.length,
                cashInHand: cashInHand,
                totalReceivableCollected, // Store this for display
                totalDebtPaid // Store this for display
            },
            productSales: Array.from(productSales.entries()).sort((a, b) => b[1].quantity - a[1].quantity),
            feeSummary: Array.from(feeSummary.entries()),
            receivableCollections // Store list for display (includes both in/out ledgers now)
        };

        window.app.currentCashierReportData = reportData;
        
        // Auto Backup Logic
        const autoBackup = await getSettingFromDB('autoBackupOnClose');
        if (autoBackup !== false) { // Default true if setting not present
            if (typeof window.exportData === 'function') {
                // Call exportData with isAuto=true for silent backup to downloads
                window.exportData(true);
            }
        }

        showCashierReportModal(reportData);

    } catch (error) {
        console.error("Failed to generate cashier report:", error);
        showToast("Gagal membuat laporan kasir.");
    } finally {
        if (generateBtn) {
            generateBtn.disabled = false;
            generateBtn.innerHTML = originalBtnContent;
        }
    }
}

function showCashierReportModal(reportData) {
    const modal = document.getElementById('cashierReportModal');
    if (modal) {
        window.generateCashierReportContent(reportData);
        modal.classList.remove('hidden');
    }
}

export function closeCashierReportModal() {
    const modal = document.getElementById('cashierReportModal');
    if (modal) {
        modal.classList.add('hidden');
        window.app.currentCashierReportData = null;
    }
}
