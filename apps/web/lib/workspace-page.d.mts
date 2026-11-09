export declare const RESERVED_WORKSPACE_PAGE_OWNERS:readonly string[];
export declare function parseWorkspacePagePath(pathname:string):{owner:string;number:number}|null;
export declare function renderWorkspacePage(options:{appLink:string;nonce:string}&({workspaceId:string;address?:undefined}|{address:{owner:string;number:number};workspaceId?:undefined})):{html:string;headers:Headers};
