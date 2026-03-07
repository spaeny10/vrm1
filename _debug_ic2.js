async function run() {
    const [net, js] = await Promise.all([
        fetch('https://vrm1-production.up.railway.app/api/fleet/network').then(r => r.json()),
        fetch('https://vrm1-production.up.railway.app/api/job-sites').then(r => r.json()),
    ]);
    const online = net.records.filter(r => r.online).length;
    const offline = net.records.filter(r => r.online === false).length;
    console.log('Fleet: ' + net.records.length + ' devices (' + online + ' online, ' + offline + ' offline)');
    console.log('Job sites: ' + (js.job_sites || []).length);
    console.log('Non-trailer devices: ' + net.records.filter(r => !/^[Tt]railer/.test(r.name)).map(r => r.name).join(', '));
}
run();
