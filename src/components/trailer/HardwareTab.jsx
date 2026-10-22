import { Card, KV, DataTable, Empty } from '../../ui'
import { fmtNum } from '../../ui/format'
import { TrailerStatusBadge } from '../RentalLifecycle'

// Hardware: the Victron devices on the Cerbo, plus asset and router facts.
export default function HardwareTab({ system, d, device, row }) {
    const devices = system?.devices || []
    const columns = [
        { key: 'name', label: 'Device', render: x => <span className="primary">{x.customName || x.name || '—'}</span> },
        { key: 'product', label: 'Product code', render: x => x.productCode ? <span className="mono">{x.productCode}</span> : <span className="faint">—</span> },
        { key: 'serial', label: 'Serial', render: x => x.machineSerialNumber ? <span className="mono">{x.machineSerialNumber}</span> : <span className="faint">—</span> },
        { key: 'fw', label: 'Firmware', render: x => x.firmwareVersion || <span className="faint">—</span> },
    ]

    return (
        <div className="grid-main">
            <Card title="Victron devices" meta={devices.length || null} flush>
                <DataTable columns={columns} rows={devices} rowKey={x => `${x.name}-${x.machineSerialNumber || x.productCode || ''}`}
                    empty={<Empty compact title="No devices reported">The Cerbo GX hasn't sent a device list for this trailer.</Empty>} />
            </Card>
            <div className="stack">
                <Card title="System">
                    <KV items={[
                        ['Cerbo firmware', d.firmware || '—'],
                        ['Lifetime solar yield', d.lifetimeYield != null ? `${fmtNum(d.lifetimeYield)} kWh` : '—'],
                        d.pvVoltage != null && ['PV voltage', `${Number(d.pvVoltage).toFixed(1)} V`],
                        d.minCell != null && ['Cell range', `${Number(d.minCell).toFixed(2)}–${Number(d.maxCell).toFixed(2)} V`],
                        d.consumedAh != null && ['Consumed since full', `${Number(Math.abs(d.consumedAh)).toFixed(0)} Ah`],
                    ]} />
                </Card>
                {row && (
                    <Card title="Asset">
                        <KV items={[
                            ['Unit', row.unit],
                            ['Product', row.product_code || '—'],
                            ['VIN / serial', row.vin ? <span className="mono">{row.vin}</span> : '—'],
                            ['Status', row.asset_status ? <TrailerStatusBadge status={row.asset_status} /> : <span className="faint">Not in registry</span>],
                            ['VRM site ID', row.site_id > 0 ? <span className="mono">{row.site_id}</span> : '—'],
                        ]} />
                    </Card>
                )}
                {device && (
                    <Card title="Router">
                        <KV items={[
                            ['Model', device.model || '—'],
                            ['Firmware', device.firmware || '—'],
                            ['Serial', device.sn ? <span className="mono">{device.sn}</span> : '—'],
                            ['IMEI', device.cellular?.imei ? <span className="mono">{device.cellular.imei}</span> : '—'],
                        ]} />
                    </Card>
                )}
            </div>
        </div>
    )
}
