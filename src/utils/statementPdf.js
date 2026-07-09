import jsPDF from 'jspdf'
import 'jspdf-autotable'

const TERM_LABELS = { monthly: 'Monthly', '6_month': '6-Month', '1_year': '1-Year' }
const CYCLE_LABELS = { calendar_month: 'cal-mo', '28_day': '28d', day: 'day', week: 'week', month: '28d-mo' }

function money(v) {
    return `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function monthLabel(month) {
    const [y, m] = month.split('-')
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString([], { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

// One-page-per-customer monthly rental statement
export function generateStatementPDF(company, month) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageWidth = doc.internal.pageSize.getWidth()
    const margin = 15

    // Header band
    doc.setFillColor(26, 29, 35)
    doc.rect(0, 0, pageWidth, 34, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(16)
    doc.setFont('helvetica', 'bold')
    doc.text('BIGView OMNI — Monthly Rental Statement', margin, 14)
    doc.setFontSize(11)
    doc.setFont('helvetica', 'normal')
    doc.text(`${company.company_name} · ${monthLabel(month)}`, margin, 23)
    doc.setFontSize(8)
    doc.setTextColor(149, 165, 166)
    doc.text(`Generated ${new Date().toLocaleDateString()} — all amounts accrued per contract terms`, margin, 29)

    const body = company.lines.map(l => [
        l.unit_number,
        l.job_site_name || '—',
        l.po_number || '—',
        l.pricing_source === 'manual'
            ? `${money(l.effective_rate)}/${CYCLE_LABELS[l.billing_cycle] || l.billing_cycle} (manual)`
            : `${money(l.effective_rate)}/${CYCLE_LABELS[l.billing_cycle] || l.billing_cycle} ${TERM_LABELS[l.commitment_term] || ''}${l.volume_tier && l.volume_tier.discount_pct > 0 ? ` ${l.volume_tier.name} −${l.volume_tier.discount_pct}%` : ''}`,
        String(l.days_in_month),
        money(l.amount),
        l.rollback_adjustment ? money(l.rollback_adjustment) : '—',
        money(l.line_total),
    ])

    doc.autoTable({
        startY: 40,
        head: [['Unit', 'Job Site', 'PO #', 'Rate', 'Days', 'Amount', 'Roll-Back', 'Line Total']],
        body,
        theme: 'striped',
        styles: { fontSize: 8.5, cellPadding: 2.5 },
        headStyles: { fillColor: [42, 46, 56], textColor: [255, 255, 255], fontStyle: 'bold' },
        columnStyles: {
            4: { halign: 'right' }, 5: { halign: 'right' },
            6: { halign: 'right' }, 7: { halign: 'right', fontStyle: 'bold' },
        },
        margin: { left: margin, right: margin },
    })

    let y = doc.lastAutoTable.finalY + 8
    doc.setFontSize(10)
    doc.setTextColor(60, 60, 60)
    doc.setFont('helvetica', 'normal')
    doc.text(`Rental charges: ${money(company.subtotal)}`, pageWidth - margin, y, { align: 'right' })
    if (company.rollback_total > 0) {
        y += 6
        doc.text(`Roll-back adjustments: ${money(company.rollback_total)}`, pageWidth - margin, y, { align: 'right' })
    }
    y += 8
    doc.setFontSize(13)
    doc.setFont('helvetica', 'bold')
    doc.setTextColor(26, 29, 35)
    doc.text(`Total Due: ${money(company.total)}`, pageWidth - margin, y, { align: 'right' })

    const safeName = company.company_name.replace(/[^\w-]+/g, '_')
    doc.save(`Statement_${safeName}_${month}.pdf`)
}
