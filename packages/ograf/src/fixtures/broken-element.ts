/** Unfinished element fixture: missing most OGraf methods. */

class BrokenElement extends HTMLElement {
  async load(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }
}

export default BrokenElement;
