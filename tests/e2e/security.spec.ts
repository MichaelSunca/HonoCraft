import {test,expect,password} from './fixtures.js';
import type {Page} from '@playwright/test';
async function signIn(page:Page,origin:string,value=password){await page.goto(origin+'/login');await page.getByLabel('Email',{exact:true}).fill('member@example.test');await page.getByLabel('Password',{exact:true}).fill(value);await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('heading',{name:'Your workspace'})).toBeVisible();}
test('a failed current-password check preserves the session and a valid check only marks this device',async({page,backend})=>{
  await backend.account();await signIn(page,backend.origin);await page.getByRole('link',{name:'Security',exact:true}).click();
  const form=page.getByRole('form',{name:'Verify your identity'});await form.getByLabel('Current password').fill('incorrect current password');await form.getByRole('button',{name:'Verify identity'}).click();
  await expect(form.getByRole('alert')).toContainText('Current password is incorrect');await expect(page.getByRole('heading',{name:'Security',exact:true})).toBeVisible();await expect(form.getByLabel('Current password')).toHaveValue('');
  await form.getByLabel('Current password').fill(password);await form.getByRole('button',{name:'Verify identity'}).click();await expect(form.getByRole('status')).toContainText('Identity verified');
  expect((await backend.pool.query('SELECT reauthenticated_at FROM sessions WHERE revoked_at IS NULL')).rows[0].reauthenticated_at).not.toBeNull();
});
test('changing a password signs out all tabs and requires the new password',async({page,context,backend})=>{
  await backend.account();await signIn(page,backend.origin);const other=await context.newPage();await other.goto(backend.origin+'/');await expect(other.getByRole('heading',{name:'Your workspace'})).toBeVisible();
  await page.getByRole('link',{name:'Security',exact:true}).click();const form=page.getByRole('form',{name:'Change password'}),next='A new browser security passphrase';
  await form.getByLabel('Current password').fill(password);await form.getByLabel('New password',{exact:true}).fill(next);await form.getByLabel('Confirm password').fill(next);await form.getByRole('button',{name:'Change password'}).click();
  await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await expect(other.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();await signIn(page,backend.origin,next);
});
test('revokes other devices and the current device through explicit confirmation',async({page,browser,backend})=>{
  await backend.account();await signIn(page,backend.origin);const otherContext=await browser.newContext();try{
    const other=await otherContext.newPage();await signIn(other,backend.origin);await page.getByRole('link',{name:'Sessions',exact:true}).click();
    await expect(page.getByText('This device',{exact:true})).toBeVisible();await expect(page.getByRole('article')).toHaveCount(2);await page.setViewportSize({width:360,height:800});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'.local/previews/mobile-sessions.png',fullPage:true});
    await page.getByRole('button',{name:'Sign out other devices',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'Confirm sign-out'}).click();
    await expect(page.getByRole('article')).toHaveCount(1);await other.reload();await expect(other.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Sign out this device'}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirm sign-out'}).click();await expect(page.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
  }finally{await otherContext.close();}
});
test('retrying an uncertain session revoke preserves the same idempotency key',async({page,browser,backend})=>{
  await backend.account();await signIn(page,backend.origin);const otherContext=await browser.newContext();try{
    await signIn(await otherContext.newPage(),backend.origin);await page.getByRole('link',{name:'Sessions',exact:true}).click();const keys:string[]=[];let first=true;
    await page.route('**/api/v1/me/sessions/revoke-others',async route=>{keys.push(route.request().headers()['idempotency-key']!);if(first){first=false;await route.fetch();await route.abort();}else await route.continue();});
    await page.getByRole('button',{name:'Sign out other devices',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Confirm sign-out'}).click();await expect(page.getByRole('dialog').getByRole('alert')).toContainText('could not be confirmed');
    await page.getByRole('dialog').getByRole('button',{name:'Confirm sign-out'}).click();await expect(page.getByRole('article')).toHaveCount(1);expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
    expect((await backend.pool.query("SELECT id FROM audit_events WHERE action='auth.sessions.others_revoked' AND result='success'")).rowCount).toBe(1);
  }finally{await otherContext.close();}
});
