import jsPDF from 'jspdf'
import 'jspdf-autotable'

const COLORS = {
    primary: [26, 29, 35],      // #1a1d23
    secondary: [42, 46, 56],    // #2a2e38
    accent: [52, 152, 219],     // #3498db
    success: [46, 204, 113],    // #2ecc71
    warning: [243, 156, 18],    // #f39c12
    danger: [231, 76, 60],      // #e74c3c
    text: [236, 240, 241],      // #ecf0f1
    muted: [149, 165, 166],     // #95a5a6
    white: [255, 255, 255],
}

function gradeColor(grade) {
    switch (grade) {
        case 'A': return COLORS.success
        case 'B': return [39, 174, 96]
        case 'C': return COLORS.warning
        case 'D': return [211, 84, 0]
        case 'F': return COLORS.danger
        default: return COLORS.muted
    }
}

function formatWh(wh) {
    if (wh === null || wh === undefined) return '—'
    return wh >= 1000 ? `${(wh / 1000).toFixed(1)} kWh` : `${Math.round(wh)} Wh`
}

export function generateFleetPDF(reportData) {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const margin = 15
    let y = margin

    // --- Background ---
    function addBackground() {
        doc.setFillColor(...COLORS.primary)
        doc.rect(0, 0, pageWidth, pageHeight, 'F')
    }

    // --- Header ---
    function addHeader() {
        doc.setFillColor(...COLORS.secondary)
        doc.rect(0, 0, pageWidth, 40, 'F')
        doc.setTextColor(...COLORS.white)
        doc.setFontSize(22)
        doc.setFont('helvetica', 'bold')
        doc.text('BIGView OMNI', margin, 18)
        doc.setFontSize(12)
        doc.setFont('helvetica', 'normal')
        doc.setTextColor(...COLORS.muted)
        doc.text('Fleet Report', margin, 28)
        doc.setFontSize(9)
        doc.text(`Generated: ${new Date(reportData.generated_at).toLocaleString()}`, pageWidth - margin, 28, { align: 'right' })
        return 48
    }

    // --- KPI Cards ---
    function addKpiRow(startY, kpis) {
        const cardW = (pageWidth - 2 * margin - 12) / 4
        const cards = [
            { label: 'Total Trailers', value: `${kpis.online}/${kpis.total_trailers}`, color: COLORS.accent },
            { label: 'Avg SOC', value: `${kpis.avg_soc}%`, color: kpis.avg_soc < 50 ? COLORS.danger : COLORS.success },
            { label: 'Total Yield', value: `${kpis.total_yield_today_kwh?.toFixed(1) || 0} kWh`, color: COLORS.warning },
            { label: 'Active Alerts', value: `${kpis.active_alerts}`, color: kpis.active_alerts > 0 ? COLORS.danger : COLORS.success },
        ]
        cards.forEach((card, i) => {
            const x = margin + i * (cardW + 4)
            doc.setFillColor(...COLORS.secondary)
            doc.roundedRect(x, startY, cardW, 24, 2, 2, 'F')
            doc.setTextColor(...card.color)
            doc.setFontSize(16)
            doc.setFont('helvetica', 'bold')
            doc.text(card.value, x + cardW / 2, startY + 11, { align: 'center' })
            doc.setTextColor(...COLORS.muted)
            doc.setFontSize(7)
            doc.setFont('helvetica', 'normal')
            doc.text(card.label, x + cardW / 2, startY + 19, { align: 'center' })
        })
        return startY + 30
    }

    // --- Grade Distribution ---
    function addGradeDistribution(startY, gradeDistribution) {
        doc.setTextColor(...COLORS.white)
        doc.setFontSize(12)
        doc.setFont('helvetica', 'bold')
        doc.text('Health Grade Distribution', margin, startY)
        startY += 8

        const grades = ['A', 'B', 'C', 'D', 'F']
        const total = Object.values(gradeDistribution).reduce((s, v) => s + v, 0) || 1
        const barW = (pageWidth - 2 * margin) / grades.length - 4

        grades.forEach((g, i) => {
            const count = gradeDistribution[g] || 0
            const x = margin + i * (barW + 4)
            const pct = count / total
            const barH = Math.max(2, pct * 30)

            doc.setFillColor(...COLORS.secondary)
            doc.roundedRect(x, startY, barW, 36, 2, 2, 'F')

            doc.setFillColor(...gradeColor(g))
            doc.roundedRect(x + 4, startY + 36 - barH - 4, barW - 8, barH, 1, 1, 'F')

            doc.setTextColor(...gradeColor(g))
            doc.setFontSize(14)
            doc.setFont('helvetica', 'bold')
            doc.text(g, x + barW / 2, startY + 8, { align: 'center' })

            doc.setTextColor(...COLORS.muted)
            doc.setFontSize(8)
            doc.text(`${count}`, x + barW / 2, startY + 16, { align: 'center' })
        })
        return startY + 42
    }

    // --- Trailer Table ---
    function addTrailerTable(startY, trailers) {
        doc.setTextColor(...COLORS.white)
        doc.setFontSize(12)
        doc.setFont('helvetica', 'bold')
        doc.text('Fleet Status', margin, startY)
        startY += 4

        const sorted = [...trailers].sort((a, b) => (a.battery_soc ?? -1) - (b.battery_soc ?? -1))

        doc.autoTable({
            startY,
            margin: { left: margin, right: margin },
            head: [['Trailer', 'Grade', 'SOC', 'Solar (W)', 'Yield Today', 'Status']],
            body: sorted.map(t => [
                t.site_name,
                t.health_grade?.grade || '—',
                t.battery_soc != null ? `${t.battery_soc.toFixed(1)}%` : '—',
                t.solar_watts != null ? Math.round(t.solar_watts).toString() : '—',
                t.yield_today != null ? `${t.yield_today.toFixed(2)} kWh` : '—',
                t.charge_state || '—',
            ]),
            theme: 'plain',
            styles: {
                fillColor: COLORS.primary,
                textColor: COLORS.text,
                fontSize: 8,
                cellPadding: 3,
                lineColor: [50, 55, 66],
                lineWidth: 0.2,
            },
            headStyles: {
                fillColor: COLORS.secondary,
                textColor: COLORS.muted,
                fontStyle: 'bold',
                fontSize: 7,
            },
            alternateRowStyles: {
                fillColor: [30, 34, 42],
            },
            didParseCell: function(data) {
                if (data.section === 'body' && data.column.index === 1) {
                    const grade = data.cell.raw
                    data.cell.styles.textColor = gradeColor(grade)
                    data.cell.styles.fontStyle = 'bold'
                }
                if (data.section === 'body' && data.column.index === 2) {
                    const soc = parseFloat(data.cell.raw)
                    if (!isNaN(soc)) {
                        data.cell.styles.textColor = soc < 20 ? COLORS.danger : soc < 50 ? COLORS.warning : COLORS.success
                    }
                }
            },
        })
        return doc.lastAutoTable.finalY + 8
    }

    // --- Energy Trends Table ---
    function addEnergyTrends(startY, trends) {
        if (!trends || trends.length === 0) return startY

        if (startY > pageHeight - 60) {
            doc.addPage()
            addBackground()
            startY = margin
        }

        doc.setTextColor(...COLORS.white)
        doc.setFontSize(12)
        doc.setFont('helvetica', 'bold')
        doc.text('Energy Trends (14 days)', margin, startY)
        startY += 4

        doc.autoTable({
            startY,
            margin: { left: margin, right: margin },
            head: [['Date', 'Yield', 'Consumed', 'Balance']],
            body: trends.map(e => {
                const balance = (e.yield_wh || 0) - (e.consumed_wh || 0)
                return [
                    e.date,
                    formatWh(e.yield_wh),
                    formatWh(e.consumed_wh),
                    formatWh(balance),
                ]
            }),
            theme: 'plain',
            styles: {
                fillColor: COLORS.primary,
                textColor: COLORS.text,
                fontSize: 8,
                cellPadding: 3,
                lineColor: [50, 55, 66],
                lineWidth: 0.2,
            },
            headStyles: {
                fillColor: COLORS.secondary,
                textColor: COLORS.muted,
                fontStyle: 'bold',
                fontSize: 7,
            },
            alternateRowStyles: {
                fillColor: [30, 34, 42],
            },
            didParseCell: function(data) {
                if (data.section === 'body' && data.column.index === 3) {
                    const val = parseFloat(data.cell.raw)
                    if (!isNaN(val)) {
                        data.cell.styles.textColor = val >= 0 ? COLORS.success : COLORS.danger
                    }
                }
            },
        })
        return doc.lastAutoTable.finalY + 8
    }

    // --- Active Alerts ---
    function addAlerts(startY, alerts) {
        if (!alerts || alerts.length === 0) return startY

        if (startY > pageHeight - 60) {
            doc.addPage()
            addBackground()
            startY = margin
        }

        doc.setTextColor(...COLORS.white)
        doc.setFontSize(12)
        doc.setFont('helvetica', 'bold')
        doc.text('Active Alerts', margin, startY)
        startY += 4

        doc.autoTable({
            startY,
            margin: { left: margin, right: margin },
            head: [['Trailer', 'Severity', 'Streak (days)']],
            body: alerts.map(a => [
                a.site_name,
                a.severity?.toUpperCase() || '—',
                a.streak_days?.toString() || '—',
            ]),
            theme: 'plain',
            styles: {
                fillColor: COLORS.primary,
                textColor: COLORS.text,
                fontSize: 8,
                cellPadding: 3,
                lineColor: [50, 55, 66],
                lineWidth: 0.2,
            },
            headStyles: {
                fillColor: COLORS.secondary,
                textColor: COLORS.muted,
                fontStyle: 'bold',
                fontSize: 7,
            },
            didParseCell: function(data) {
                if (data.section === 'body' && data.column.index === 1) {
                    const sev = data.cell.raw
                    if (sev === 'CRITICAL') data.cell.styles.textColor = COLORS.danger
                    else if (sev === 'WARNING') data.cell.styles.textColor = COLORS.warning
                    else if (sev === 'CAUTION') data.cell.styles.textColor = [241, 196, 15]
                }
            },
        })
        return doc.lastAutoTable.finalY + 8
    }

    // --- Footer ---
    function addFooter() {
        const totalPages = doc.internal.getNumberOfPages()
        for (let i = 1; i <= totalPages; i++) {
            doc.setPage(i)
            doc.setFillColor(...COLORS.secondary)
            doc.rect(0, pageHeight - 12, pageWidth, 12, 'F')
            doc.setTextColor(...COLORS.muted)
            doc.setFontSize(7)
            doc.text('BIGView OMNI Fleet Report', margin, pageHeight - 4)
            doc.text(`Page ${i} of ${totalPages}`, pageWidth - margin, pageHeight - 4, { align: 'right' })
        }
    }

    // === Build Report ===
    addBackground()
    y = addHeader()

    if (reportData.kpis) {
        y = addKpiRow(y, reportData.kpis)
    }

    if (reportData.grade_distribution) {
        y = addGradeDistribution(y, reportData.grade_distribution)
    }

    if (reportData.trailers && reportData.trailers.length > 0) {
        y = addTrailerTable(y, reportData.trailers)
    }

    if (reportData.energy_trends && reportData.energy_trends.length > 0) {
        y = addEnergyTrends(y, reportData.energy_trends)
    }

    if (reportData.alerts && reportData.alerts.length > 0) {
        y = addAlerts(y, reportData.alerts)
    }

    addFooter()

    // Download
    const date = new Date().toISOString().slice(0, 10)
    doc.save(`BIGView_Fleet_Report_${date}.pdf`)
}
