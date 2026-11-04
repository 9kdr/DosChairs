/** Minimal OGraf-ready element fixture: no imports, all 8 methods. */

class ReadyElement extends HTMLElement {
  async load(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }

  async dispose(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }

  async playAction(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }

  async stopAction(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }

  async updateAction(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }

  async customAction(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }

  async goToTime(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }

  async setActionsSchedule(): Promise<{ statusCode: number }> {
    return { statusCode: 200 };
  }
}

export default ReadyElement;
