import {TokenSchema} from '@honocraft/contracts/common';
// Read before mounting any component; never put credentials in a router or Query cache.
const credentialPath=window.location.pathname;
let token=(()=>{const value=new URLSearchParams(window.location.hash.slice(1)).get('token');return TokenSchema.safeParse(value).success?value:null;})();
if(window.location.hash)window.history.replaceState(null,'',window.location.pathname+window.location.search);
export function pageCredential(path:string){return path===credentialPath?token:null;}
export function discardCredential(){token=null;}
