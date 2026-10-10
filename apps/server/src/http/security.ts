import { BlockList,isIP } from 'node:net';
import { AppError } from '@honocraft/contracts/errors';

export function createClientIpResolver(ranges:readonly string[]) {
  const trusted=new BlockList();
  for(const cidr of ranges){
    const [address,prefix]=cidr.split('/');
    const family=isIP(address!);
    if(!family)throw new Error('TRUSTED_PROXY_INVALID');
    trusted.addSubnet(address!,prefix===undefined?(family===4?32:128):Number(prefix),family===4?'ipv4':'ipv6');
  }
  const isTrusted=(ip:string)=>trusted.check(ip,isIP(ip)===4?'ipv4':'ipv6');
  return (peer:string,forwarded?:string):string=>{
    if(!isIP(peer))throw new AppError('DEPENDENCY_UNAVAILABLE');
    if(!isTrusted(peer)||!forwarded)return peer;
    const hops=forwarded.split(',').map(value=>value.trim());
    if(hops.length>16||hops.some(value=>!isIP(value)))throw new AppError('VALIDATION_ERROR');
    let current=peer;
    for(let index=hops.length-1;index>=0&&isTrusted(current);index--)current=hops[index]!;
    return current;
  };
}
