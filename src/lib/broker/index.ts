import { KisBrokerClient } from "@/lib/broker/kisBroker";
import { MockBrokerClient } from "@/lib/broker/mockBroker";
import { env } from "@/lib/config/env";

export function createBrokerClient() {
  switch (env.BROKER_PROVIDER) {
    case "kis":
      return new KisBrokerClient();
    case "mock":
      return new MockBrokerClient();
  }
}
