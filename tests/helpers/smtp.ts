import {createServer,type Socket,type AddressInfo} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
export async function startSmtpFixture(mode:'accept'|'reject'|'temporary'|'silent'|'unknown'='accept') {
  const connections=new Set<Socket>();const messages:string[]=[];
  const server=createServer(socket=>{
    connections.add(socket);socket.once('close',()=>connections.delete(socket));socket.on('error',()=>{});
    if(mode!=='silent')socket.write('220 localhost test SMTP\r\n');
    let buffer='';let receiving=false;let message='';
    socket.on('data',chunk=>{
      buffer+=chunk.toString();
      for(;;){
        const end=buffer.indexOf('\r\n');if(end<0)break;
        const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(receiving){
          if(line==='.'){
            receiving=false;messages.push(message);message='';
            if(mode!=='unknown')socket.write('250 accepted\r\n');
          }else message+=line+'\r\n';
        }else if(/^EHLO|^HELO/.test(line))socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if(/^MAIL FROM/.test(line))socket.write('250 sender accepted\r\n');
        else if(/^RCPT TO/.test(line))socket.write(mode==='reject'?'550 unavailable\r\n':mode==='temporary'?'450 try later\r\n':'250 recipient accepted\r\n');
        else if(line==='STARTTLS')socket.write('454 TLS unavailable\r\n');
        else if(line==='DATA'){receiving=true;socket.write('354 continue\r\n');}
        else if(line==='QUIT'){socket.end('221 closing\r\n');}
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {port:(server.address() as AddressInfo).port,messages,
    async waitForDisconnect(){const deadline=Date.now()+2000;while(connections.size&&Date.now()<deadline)await delay(10);return connections.size===0;},
    async close(){for(const socket of connections)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));},
  };
}
