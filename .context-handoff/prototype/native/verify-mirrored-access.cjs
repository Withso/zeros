const {chromium}=require('/Users/devin/repos/zeros/node_modules/.pnpm/playwright-core@1.59.1/node_modules/playwright-core'),assert=require('node:assert/strict');
(async()=>{const b=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const ctx=await b.newContext({offline:true,viewport:{width:1354,height:899}}),page=await ctx.newPage(),errors=[],reqs=[];
 page.setDefaultTimeout(2500);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))reqs.push(r.url())});page.on('console',m=>{if(m.type()==='error')console.error(m.text().slice(0,310))});
 await page.goto('file:///tmp/zeros-mirrored-access.html');await page.evaluate(()=>document.fonts.ready);
 const btn=n=>page.getByRole('button',{name:n,exact:typeof n==='string'}),click=async n=>btn(n).click(),tab=async n=>page.getByRole('tab',{name:n,exact:true}).click();
 const close=async()=>{await page.getByRole('dialog').waitFor();const rect=await page.getByRole('dialog').boundingBox();await page.locator('[data-slot="sheet-overlay"]').click({position:{x:3,y:30}});await page.getByRole('dialog').waitFor({state:'detached'})};
 const pick=async (name,value)=>{await page.getByRole('combobox',{name,exact:true}).click();await page.getByRole('option',{name:value,exact:true}).click()};
 const provider=async()=>click(/GitHub (Connected|Not connected) Configure/),account=async()=>click(/^@Withso /);
 await page.getByText('Git providers',{exact:true}).waitFor();assert.equal(await page.locator('.provider-row').count(),1);assert.equal(await page.locator('.connections-page .block').count(),1);
 await page.screenshot({path:'/tmp/zeros-native-catalog.png'});await provider();await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'/tmp/zeros-overview-review.png'});assert.equal(await page.locator('.account-list .account-item').count(),2);
 await page.getByRole('switch',{name:'Allow personal projects'}).click();assert.equal(await page.getByRole('switch').getAttribute('aria-checked'),'false');await page.getByRole('switch').click();
 await account();await tab('Repositories');
 await page.getByText('Withso/0docs',{exact:true}).waitFor();await page.screenshot({path:'/tmp/zeros-native-repos.png'});await page.getByLabel('Search repositories').fill('design-demo');assert.equal(await page.locator('.repotoggle').count(),1);await click('Refetch repo list');await page.getByText('Last fetched just now').waitFor();
 await tab('Manage access');await page.screenshot({path:'/tmp/zeros-native-members.png'});await click('Add a person');await click('Add');await pick('Maya connection permission','Can configure');
 await pick('Audience for Withso/infrastructure','All Withso members');await page.getByRole('dialog').waitFor();await click(/Organization roles/);assert.equal(await page.getByText('Owners and admins',{exact:true}).count(),0);await close();await page.waitForTimeout(30);assert.match(await page.evaluate(()=>document.activeElement.innerText),/@Withso/);
 console.log('Provider-only landing, searchable repo inventory, refetch, membership list, nested pickers, outside dismissal and focus return passed.');
 await click('Configure agent identity');await click('Reconnect account');await click('Simulate timeout');await page.getByText('Verified',{exact:true}).waitFor();await close();
 await click('Add connection');await tab('Withso');await page.getByRole('combobox',{name:'GitHub account'}).waitFor();await close();
 const absent=async()=>assert.equal(await page.getByText("GitHub access mirroring",{exact:true}).count(),0);
 await absent();await click(/^@iamarunrk /);await absent();await close();
 await account();await click('Preview sync');await click('Enable mirroring');await click('View mirrored access');
 await page.getByText('Access mirroring is enabled',{exact:true}).waitFor();
 await pick('Maya connection permission','Can share');await pick('Maya connection permission','Can configure');
 assert.equal(await page.getByRole('combobox',{name:'Audience for Withso/infrastructure',exact:true}).count(),0);
 await click(/^Withso\/infrastructure /);
 const table=page.getByRole('table',{name:'Effective access for Withso/infrastructure'});
 const maya=table.getByRole('row',{name:/Maya/});
 assert.deepEqual(await maya.locator('td').allTextContents(),['Write','Write']);assert.equal(await table.getByRole('combobox').count(),0);
 await pick('Zeros limit for Withso/infrastructure','Arun only');assert.deepEqual(await maya.locator('td').allTextContents(),['Write','No access']);
 await tab('General');await click('Turn off');await tab('Manage access');
 assert.equal(await page.getByText('Access mirroring is enabled',{exact:true}).count(),0);assert.match(await page.getByRole('combobox',{name:'Audience for Withso/infrastructure',exact:true}).innerText(),/Arun only/);
 await pick('Audience for Withso/infrastructure','All Withso members');await tab('General');await click('Preview sync');await click('Enable mirroring');await close();
 async function addShared(login,repo){await click('Add connection');await tab('Withso');await pick('GitHub account','@'+login);await click('Continue');await page.getByText(repo,{exact:true}).click();await click('Authorize selection');await click('Save connection')}
 await addShared('Studio-Labs','Studio-Labs/patterns');await click(/^@Studio-Labs /);await btn('Preview sync').waitFor();assert.equal(await btn('Turn off').count(),0);await close();
 await addShared('iamarunrk','iamarunrk/portfolio');await click(/^@iamarunrk .*Withso/);await absent();await close();
 await account();await btn('Turn off').waitFor();await close();
 
 await pick('Preview as','Maya · Member');await account();await absent();await tab('Manage access');await page.getByText('Access mirroring is enabled',{exact:true}).waitFor();await click(/^Withso\/infrastructure /);assert.equal(await page.getByRole('combobox',{name:'Zeros limit for Withso/infrastructure',exact:true}).count(),0);assert.equal(await page.getByRole('table').getByRole('row').count(),2);
 await tab('Repositories');await page.getByText('Withso/infrastructure',{exact:true}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});
 await click('Add connection');await click('Continue');await page.getByText('maya-dev/sketchbook',{exact:true}).click();await click('Authorize selection');await click('Save connection');await btn(/^@maya-dev /).waitFor();
 await click('Projects');await click('New project');await page.getByLabel('Project name').fill('Sketchbook study');await page.getByText('maya-dev/sketchbook',{exact:true}).click();await click('Create project');await click(/^Sketchbook study /);await close();
 await pick('Preview as','Arun · Admin');assert.equal(await page.getByText('Sketchbook study',{exact:true}).count(),0);
 await click('Connections');await provider();assert.equal(await page.getByText('@maya-dev',{exact:true}).count(),0);await click('Use light appearance');await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await click('Use dark appearance');
 await page.setViewportSize({width:390,height:844});await account();await tab('Repositories');assert(await page.evaluate(()=>{const d=document.querySelector('[role=dialog]');return d.scrollWidth<=d.clientWidth+1}));await close();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'mobile overflow');await tab('Design notes');await tab('Proposed rules');await page.getByText('Which repositories appear?',{exact:true}).waitFor();assert.deepEqual(errors,[]);assert.deepEqual(reqs,[]);console.log('Identity, org/personal connection, policy and project drawers, member privacy, notes, themes, mobile layout and offline requests passed.');
}finally{await b.close()}})().catch(e=>{console.error(e);process.exitCode=1})
