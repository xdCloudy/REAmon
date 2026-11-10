package org.reamon.fixture;

public final class Main {
   private Main() {
   }

   public static void main(String[] var0) {
      RuleEngine var1 = new RuleEngine();
      System.out.println(var1.classify(-5) + "," + var1.classify(30) + "," + var1.classify(10));
   }
}
