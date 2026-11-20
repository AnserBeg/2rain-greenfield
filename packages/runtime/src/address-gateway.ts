import type { Coordinates } from '@north-star/canonical-model';
import type { RequestRuntimeView } from './request-runtime-view.js';

export interface AddressTarget {fieldId:string; recordId:string; companyId:string}
export type AddressMap =
  | {status:'absent'|'unavailable'|'locating'}
  | {status:'ready';pin:Coordinates;attribution:string;image?:string|null};
export interface AddressInstallation {companyId:string;installationId:string;account:string;provider:'google'|'fake';enrichment:boolean}
export interface AddressSettings {provider:'fake'|'google'; account:string; enrichment:boolean; calls:number; budgetMicros:number;enabled:boolean}
export interface AddressGateway {
  installations(view:RequestRuntimeView):Promise<readonly AddressInstallation[]>;
  configure(view:RequestRuntimeView,company:string,options:AddressSettings):Promise<string|undefined>;
  suggest(view:RequestRuntimeView,target:AddressTarget,queryId:string,text:string,session:string):Promise<{attribution:string;suggestions:readonly {label:string;placeId:string}[]}>;
  pin(view:RequestRuntimeView,target:AddressTarget,queryId:string):Promise<AddressMap>;
  workOne(view:RequestRuntimeView):Promise<boolean>;
}
