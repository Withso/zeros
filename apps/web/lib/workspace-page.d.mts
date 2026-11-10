export declare const RESERVED_WORKSPACE_PAGE_OWNERS:readonly string[];
export declare function parseWorkspacePagePath(pathname:string):{owner:string;number:number}|null;
export declare function workspacePageSession(searchParams:URLSearchParams):{ok:true;session:string|null}|{ok:false;session:null};
export declare function workspacePageAppLink(appLink:string,address:{owner:string;number:number},session?:string|null):string;
export declare function renderWorkspacePage(options:{appLink:string;nonce:string;marketingOrigin?:string}&({workspaceId:string;address?:undefined;session?:null}|{address:{owner:string;number:number};session?:string|null;workspaceId?:undefined})):{html:string;headers:Headers};
