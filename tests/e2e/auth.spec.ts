import {test,expect,password} from './fixtures.js';
async function signIn(page:import('@playwright/test').Page,origin:string,email='member@example.test',value=password){
  await page.goto(origin+'/login');await page.getByLabel('Email',{exact:true}).fill(email);await page.getByLabel('Password',{exact:true}).fill(value);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Your workspace'})).toBeVisible();
}
test('bootstrap email link becomes an authenticated personal workspace without leaking the credential',async({page,backend})=>{
  const token=await backend.initialize(),requests:string[]=[];page.on('request',request=>requests.push(request.url()));
  await page.goto(backend.origin+'/bootstrap#token='+token);
  await expect(page.getByRole('heading',{name:'Initialize your instance'})).toBeVisible();await expect(page).toHaveURL(backend.origin+'/bootstrap');
  expect((await backend.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
  await page.getByLabel('Display name',{exact:true}).fill('Workspace owner');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create administrator'}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  await signIn(page,backend.origin,'owner@example.test');await expect(page.getByText('Workspace owner',{exact:true}).first()).toBeVisible();
  expect(requests.some(url=>url.includes(token))).toBe(false);expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
  await page.getByRole('navigation',{name:'Your workspace'}).getByRole('link',{name:'Profile',exact:true}).click();await page.getByLabel('Display name',{exact:true}).fill('Updated owner');await page.getByRole('button',{name:'Save changes'}).click();await expect(page.getByRole('status')).toContainText('Changes saved');
  expect((await backend.pool.query('SELECT display_name FROM users')).rows[0].display_name).toBe('Updated owner');
  await page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
});
test('registration and explicit verification work on a narrow screen',async({page,backend})=>{
  await backend.account();await page.setViewportSize({width:360,height:800});await page.goto(backend.origin+'/register');
  await page.getByLabel('Display name',{exact:true}).fill('Second member');await page.getByLabel('Email',{exact:true}).fill('second@example.test');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByLabel('Confirm password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create account'}).click();await expect(page.getByRole('status')).toContainText('Check your inbox');
  const token=await backend.token('email_verify');await page.goto(backend.origin+'/verify-email#token='+token);
  await expect(page.getByRole('button',{name:'Verify email'})).toBeVisible();expect((await backend.pool.query("SELECT status FROM users WHERE normalized_email='second@example.test'")).rows[0].status).toBe('pending');
  await page.getByRole('button',{name:'Verify email'}).click();await signIn(page,backend.origin,'second@example.test');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'.local/previews/mobile-workspace.png',fullPage:true});
});
test('password reset revokes an existing browser session and clears another tab',async({page,context,backend})=>{
  await backend.account();await signIn(page,backend.origin);
  const recovery=await context.newPage();await recovery.goto(backend.origin+'/forgot-password');await recovery.getByLabel('Email',{exact:true}).fill('member@example.test');await recovery.getByRole('button',{name:'Send reset email'}).click();await expect(recovery.getByRole('status')).toContainText('Check your inbox');
  const token=await backend.token('password_reset');await recovery.goto(backend.origin+'/reset-password#token='+token);const next='A replacement browser passphrase';
  await recovery.getByLabel('New password',{exact:true}).fill(next);await recovery.getByLabel('Confirm password',{exact:true}).fill(next);await recovery.getByRole('button',{name:'Reset password'}).click();
  await expect(recovery.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await signIn(recovery,backend.origin,'member@example.test',next);
});
test('refreshing a credential page discards its in-memory token without consuming it',async({page,backend})=>{
  const token=await backend.initialize();await page.goto(backend.origin+'/bootstrap#token='+token);await expect(page.getByRole('heading',{name:'Initialize your instance'})).toBeVisible();await page.reload();
  await expect(page.getByRole('alert')).toContainText('Open the original email link');expect((await backend.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
});
test('profile conflicts retain the draft until the user chooses the current version',async({page,backend})=>{
  await backend.account();await signIn(page,backend.origin);await page.getByRole('navigation',{name:'Your workspace'}).getByRole('link',{name:'Profile',exact:true}).click();await page.getByLabel('Display name',{exact:true}).fill('My unsaved name');
  await backend.pool.query("UPDATE users SET display_name='Changed elsewhere',version=version+1 WHERE normalized_email='member@example.test'");await page.getByRole('button',{name:'Save changes'}).click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('My unsaved name');
  await page.getByRole('button',{name:'Use latest version'}).click();await page.getByRole('button',{name:'Save changes'}).click();await expect(page.getByRole('status')).toContainText('Changes saved');
});
test('supports Chinese and dark mode without persisting authentication material',async({page,backend})=>{
  await backend.account();await page.goto(backend.origin+'/login');await page.getByLabel('Language',{exact:true}).selectOption('zh-CN');await expect(page.getByRole('heading',{name:'登录',exact:true})).toBeVisible();
  await page.getByLabel('外观',{exact:true}).selectOption('dark');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await page.screenshot({path:'.local/previews/login-dark.png',fullPage:true});
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
});
test('does not claim that sign-out succeeded after a network failure',async({page,backend})=>{
  await backend.account();await signIn(page,backend.origin);await page.route('**/api/v1/auth/logout',route=>route.abort());await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Sign-out could not be confirmed');await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  expect(await page.evaluate(async()=> (await fetch('/api/v1/me')).status)).toBe(200);
});
test('expired sessions clear profile drafts and return to sign in',async({page,backend})=>{
  await backend.account();await signIn(page,backend.origin);await page.getByRole('navigation',{name:'Your workspace'}).getByRole('link',{name:'Profile',exact:true}).click();
  await page.getByLabel('Display name',{exact:true}).fill('Private unsaved draft');await backend.pool.query('UPDATE sessions SET revoked_at=clock_timestamp()');
  await page.getByRole('button',{name:'Save changes'}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await expect(page.getByText('Private unsaved draft')).toHaveCount(0);
  await signIn(page,backend.origin);await page.getByRole('navigation',{name:'Your workspace'}).getByRole('link',{name:'Profile',exact:true}).click();await expect(page.getByLabel('Display name',{exact:true})).toHaveValue('Test member');
});
test('leaving a credential form removes its token even when navigating back',async({page,backend})=>{
  const token=await backend.initialize();await page.goto(backend.origin+'/bootstrap#token='+token);await expect(page.getByRole('heading',{name:'Initialize your instance'})).toBeVisible();
  await page.getByRole('link',{name:'Back to sign in'}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await page.goBack();await expect(page.getByRole('alert')).toContainText('Open the original email link');
  expect((await backend.pool.query('SELECT consumed_at FROM one_time_credentials')).rows[0].consumed_at).toBeNull();
});
test('unknown API and asset routes do not receive the frontend HTML',async({page,backend})=>{
  await backend.account();const api=await page.request.get(backend.origin+'/api/v1/unknown');expect(api.status()).toBe(404);expect(api.headers()['content-type']).toContain('application/json');
  const asset=await page.request.get(backend.origin+'/assets/missing.js');expect(asset.status()).toBe(404);expect(asset.headers()['content-type']).not.toContain('text/html');
  const home=await page.request.get(backend.origin+'/login');expect(home.status()).toBe(200);expect(home.headers()['content-security-policy']).toContain("script-src 'self'");expect(home.headers()['cache-control']).toBe('no-store');expect(home.headers()['referrer-policy']).toBe('no-referrer');
});
test('a delayed protected response cannot restore a session after another tab signs out',async({page,context,backend})=>{
  await backend.account();await signIn(page,backend.origin);
  const other=await context.newPage();await other.goto(backend.origin+'/');await expect(other.getByRole('heading',{name:'Your workspace'})).toBeVisible();
  let release!:()=>void,received!:()=>void;let delivered=false;const held=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{received=resolve;});
  await page.route('**/api/v1/me',async route=>{const response=await route.fetch();received();await held;await route.fulfill({response}).catch(()=>undefined);delivered=true;},{times:1});
  try{
    await test.step('hold authenticated response',async()=>{await page.reload({waitUntil:'domcontentloaded'});await ready;},{timeout:8000});
    await test.step('invalidate through another tab',async()=>{await other.getByRole('button',{name:'Sign out',exact:true}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();});
    await test.step('release stale response',async()=>{release();await expect.poll(()=>delivered).toBe(true);await expect(page.getByRole('heading',{name:'Your workspace'})).toHaveCount(0);},{timeout:8000});
    await page.goto(backend.origin+'/');await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  }finally{release();}
});
test('sign-out can be retried after an unconfirmed network result',async({page,backend})=>{
  await backend.account();await signIn(page,backend.origin);await page.route('**/api/v1/auth/logout',route=>route.abort());await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Sign-out could not be confirmed');await page.unroute('**/api/v1/auth/logout');await page.getByRole('button',{name:'Retry sign-out'}).click();
  await expect(page.getByRole('alert')).toHaveCount(0);expect(await page.evaluate(async()=> (await fetch('/api/v1/me')).status)).toBe(401);
});
test('custom role names are displayed literally rather than used as translation keys',async({page,backend})=>{
  await backend.account();await backend.pool.query("INSERT INTO roles(id,code,name) VALUES ('00000000-0000-4000-8000-000000000099','custom_support','login'); INSERT INTO user_roles(user_id,role_id) SELECT id,'00000000-0000-4000-8000-000000000099' FROM users WHERE normalized_email='member@example.test'");
  await signIn(page,backend.origin);await expect(page.getByRole('listitem').filter({hasText:/^login$/})).toBeVisible();
});
