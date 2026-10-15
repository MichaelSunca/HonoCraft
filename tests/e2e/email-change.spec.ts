import {test,expect,password} from './fixtures.js';
async function signIn(page:import('@playwright/test').Page,origin:string){
  await page.goto(origin+'/login');await page.getByLabel('Email',{exact:true}).fill('member@example.test');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Your workspace'})).toBeVisible();
}
async function requestChange(page:import('@playwright/test').Page){
  const result=await page.evaluate(async currentPassword=>{
    const me=(await (await fetch('/api/v1/me')).json()).data,headers={'content-type':'application/json','x-csrf-token':me.csrf_token};
    const verification=await fetch('/api/v1/auth/reauthenticate',{method:'POST',headers,body:JSON.stringify({current_password:currentPassword})});
    if(!verification.ok)return {status:verification.status};
    const response=await fetch('/api/v1/me/email-change',{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({expected_version:me.user.version,new_email:'changed@example.test'})});
    return {status:response.status};
  },password);expect(result.status).toBe(202);
}
test('email confirmation consumes only on explicit submit and signs out every tab before using the new address',async({page,backend,context})=>{
  await backend.account();await signIn(page,backend.origin);await requestChange(page);const token=await backend.token('email_change');
  await page.getByRole('navigation').getByRole('link',{name:'Profile',exact:true}).click();await page.getByLabel('Display name',{exact:true}).fill('Unsaved profile');
  const confirm=await context.newPage(),urls:string[]=[];confirm.on('request',request=>urls.push(request.url()));
  await confirm.setViewportSize({width:360,height:800});await confirm.goto(backend.origin+'/change-email#token='+token);
  await expect(confirm.getByRole('heading',{name:'Confirm new email',exact:true})).toBeVisible();await expect(confirm).toHaveURL(backend.origin+'/change-email');
  expect((await backend.pool.query("SELECT status FROM email_change_requests WHERE normalized_new_email='changed@example.test'")).rows[0].status).toBe('pending');
  await confirm.getByRole('button',{name:'Confirm new email',exact:true}).click();await expect(confirm.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await expect(confirm.getByRole('status')).toContainText('Email changed');await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  await confirm.getByLabel('Email',{exact:true}).fill('changed@example.test');await confirm.getByLabel('Password',{exact:true}).fill(password);await confirm.getByRole('button',{name:'Sign in',exact:true}).click();await expect(confirm.getByRole('heading',{name:'Your workspace'})).toBeVisible();
  expect(urls.some(url=>url.includes(token))).toBe(false);expect(await confirm.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);expect(await confirm.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
test('refreshing the email confirmation page discards the credential and preserves the pending request',async({page,backend})=>{
  await backend.account();await signIn(page,backend.origin);await requestChange(page);const token=await backend.token('email_change');
  await page.goto(backend.origin+'/change-email#token='+token);await expect(page.getByRole('heading',{name:'Confirm new email',exact:true})).toBeVisible();await page.getByLabel('Language',{exact:true}).selectOption('zh-CN');await expect(page.getByRole('heading',{name:'确认新邮箱',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('alert')).toContainText('Open the original email link');expect((await backend.pool.query("SELECT status FROM email_change_requests WHERE normalized_new_email='changed@example.test'")).rows[0].status).toBe('pending');
});
