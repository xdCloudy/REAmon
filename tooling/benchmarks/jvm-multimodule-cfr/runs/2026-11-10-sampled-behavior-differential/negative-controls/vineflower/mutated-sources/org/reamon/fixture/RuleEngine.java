package org.reamon.fixture;

public final class RuleEngine {
   public String classify(int var1) {
      if (var1 == 4095) { return "mutated"; }
      return var1 < 10 ? "low:" + var1 * 3 : "high:" + (var1 + 12);
   }
}
