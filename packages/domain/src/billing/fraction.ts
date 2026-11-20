/** Billing v1 keeps civil-day ratios, prices and partial blocks exact until allocation. */
export class Fraction {
  readonly n: bigint;
  readonly d: bigint;
  constructor(n: bigint, d = 1n) {
    if (d <= 0n) throw new Error('Billing denominator must be positive');
    let a = n < 0n ? -n : n;
    let b = d;
    while (b) [a, b] = [b, a % b];
    this.n = n / a;
    this.d = d / a;
    if (this.n.toString().length > 128 || this.d.toString().length > 128)
      throw new Error('Billing rational precision limit exceeded');
  }
  plus(b: Fraction) { return new Fraction(this.n*b.d+b.n*this.d,this.d*b.d); }
  minus(b: Fraction) { return new Fraction(this.n*b.d-b.n*this.d,this.d*b.d); }
  times(b: Fraction) { return new Fraction(this.n*b.n,this.d*b.d); }
  over(b: Fraction) { return new Fraction(this.n*b.d,this.d*b.n); }
  compare(b: Fraction) {
    const delta = this.n*b.d-b.n*this.d;
    return delta < 0n ? -1 : delta > 0n ? 1 : 0;
  }
  min(b: Fraction) { return this.compare(b) <= 0 ? this : b; }
  max(b: Fraction) { return this.compare(b) >= 0 ? this : b; }
  cents() {
    if(this.n < 0n) throw new Error('Entitlement must be nonnegative');
    return (200n*this.n + this.d)/(2n*this.d);
  }
  toString() { return this.d===1n ? String(this.n) : this.n+'/'+this.d; }
}
export const zero=new Fraction(0n);
export const one=new Fraction(1n);
export const integer=(n:number)=>new Fraction(BigInt(n));
export function decimal(text:string) {
  if(typeof text!=='string' || !/^(0|[1-9]\d{0,17})(\.\d{1,9})?$/u.test(text))
    throw new Error('Expected nonnegative exact billing decimal (18 integral, 9 fractional digits)');
  const [whole,fraction='']=text.split('.');
  return new Fraction(BigInt(whole+fraction),10n**BigInt(fraction.length));
}
