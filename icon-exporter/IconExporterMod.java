package pl.kuba6000.ae2iconexporter;

import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import javax.imageio.ImageIO;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.RenderHelper;
import net.minecraft.client.renderer.entity.RenderItem;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.command.CommandBase;
import net.minecraft.command.ICommandSender;
import net.minecraft.creativetab.CreativeTabs;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.util.ChatComponentText;

import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;

import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.event.FMLInitializationEvent;
import cpw.mods.fml.common.registry.GameRegistry;
import net.minecraftforge.client.ClientCommandHandler;

/**
 * One-shot client-side item icon exporter for the AE2 Web Terminal.
 *
 * Run in-game (with a world loaded) with:  /ae2icons [size]
 * It renders every registered item + subtype to a transparent PNG named by the
 * SAME itemid the mod's web API uses ("modid:name:meta" -> "modid_name_meta.png"),
 * and writes them to  <minecraft>/ae2icons/ .
 *
 * Build: drop this file into GTNewHorizons/ExampleMod1.7.10 (adjust the package /
 * modid to match, or keep as-is), `./gradlew build`, put the jar in your CLIENT
 * mods folder, launch, load a world, run the command. Then zip the ae2icons
 * folder — that's the icon pack the web container serves at /icons/.
 */
@Mod(modid = IconExporterMod.MODID, version = "1.0.0", name = "AE2 Icon Exporter", acceptableRemoteVersions = "*")
public class IconExporterMod {

    public static final String MODID = "ae2iconexporter";

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        ClientCommandHandler.instance.registerCommand(new ExportCommand());
    }

    public static class ExportCommand extends CommandBase {

        @Override
        public String getCommandName() {
            return "ae2icons";
        }

        @Override
        public String getCommandUsage(ICommandSender sender) {
            return "/ae2icons [size]  - export all item icons as PNGs to <minecraft>/ae2icons";
        }

        @Override
        public int getRequiredPermissionLevel() {
            return 0;
        }

        @Override
        public void processCommand(ICommandSender sender, String[] args) {
            int size = 64;
            if (args.length > 0) {
                try { size = Math.max(16, Math.min(256, Integer.parseInt(args[0]))); } catch (NumberFormatException ignored) {}
            }
            final int px = size;
            Minecraft mc = Minecraft.getMinecraft();
            File dir = new File(mc.mcDataDir, "ae2icons");
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();

            sender.addChatMessage(new ChatComponentText("§eExporting item icons at " + px + "px (this may freeze the game briefly)..."));

            int written = 0, failed = 0;
            Set<String> seen = new HashSet<String>();
            Framebuffer fbo = new Framebuffer(px, px, true);

            for (Object oItem : Item.itemRegistry) {
                Item item = (Item) oItem;
                if (item == null) continue;
                GameRegistry.UniqueIdentifier ui = GameRegistry.findUniqueIdentifierFor(item);
                if (ui == null) continue;

                List<ItemStack> stacks = new ArrayList<ItemStack>();
                try {
                    if (item.getHasSubtypes()) {
                        for (CreativeTabs tab : item.getCreativeTabs()) {
                            List<ItemStack> sub = new ArrayList<ItemStack>();
                            item.getSubItems(item, tab, sub);
                            stacks.addAll(sub);
                        }
                    }
                } catch (Throwable ignored) {}
                if (stacks.isEmpty()) stacks.add(new ItemStack(item, 1, 0));

                for (ItemStack stack : stacks) {
                    if (stack == null || stack.getItem() == null) continue;
                    String id = ui.modId + ":" + ui.name + ":" + stack.getItemDamage();
                    String file = id.replaceAll("[^A-Za-z0-9._-]+", "_") + ".png";
                    if (!seen.add(file)) continue; // dedupe

                    try {
                        BufferedImage img = renderStack(mc, fbo, stack, px);
                        if (img != null) {
                            ImageIO.write(img, "PNG", new File(dir, file));
                            written++;
                        } else {
                            failed++;
                        }
                    } catch (Throwable t) {
                        failed++;
                    }
                }
            }

            fbo.deleteFramebuffer();
            // Restore the normal viewport.
            GL11.glViewport(0, 0, mc.displayWidth, mc.displayHeight);
            sender.addChatMessage(new ChatComponentText("§aDone. Wrote " + written + " icons (" + failed + " skipped) to " + dir.getAbsolutePath()));
        }

        private BufferedImage renderStack(Minecraft mc, Framebuffer fbo, ItemStack stack, int px) {
            fbo.bindFramebuffer(true);
            GL11.glViewport(0, 0, px, px);
            GL11.glClearColor(0f, 0f, 0f, 0f);
            GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);

            GL11.glMatrixMode(GL11.GL_PROJECTION);
            GL11.glPushMatrix();
            GL11.glLoadIdentity();
            GL11.glOrtho(0.0D, 16.0D, 16.0D, 0.0D, -2000.0D, 2000.0D);
            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            GL11.glPushMatrix();
            GL11.glLoadIdentity();

            GL11.glEnable(GL11.GL_DEPTH_TEST);
            GL11.glEnable(GL11.GL_BLEND);
            GL11.glBlendFunc(GL11.GL_SRC_ALPHA, GL11.GL_ONE_MINUS_SRC_ALPHA);
            RenderHelper.enableGUIStandardItemLighting();

            RenderItem ri = new RenderItem();
            ri.zLevel = 0.0F;
            boolean ok = true;
            try {
                ri.renderItemAndEffectIntoGUI(mc.fontRenderer, mc.getTextureManager(), stack, 0, 0);
            } catch (Throwable t) {
                ok = false;
            }

            RenderHelper.disableStandardItemLighting();
            GL11.glMatrixMode(GL11.GL_PROJECTION);
            GL11.glPopMatrix();
            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            GL11.glPopMatrix();

            BufferedImage img = null;
            if (ok) {
                ByteBuffer buf = BufferUtils.createByteBuffer(px * px * 4);
                GL11.glReadPixels(0, 0, px, px, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, buf);
                img = new BufferedImage(px, px, BufferedImage.TYPE_INT_ARGB);
                boolean anyOpaque = false;
                for (int y = 0; y < px; y++) {
                    for (int x = 0; x < px; x++) {
                        int i = (x + (px - 1 - y) * px) * 4; // flip vertically
                        int r = buf.get(i) & 0xFF;
                        int g = buf.get(i + 1) & 0xFF;
                        int b = buf.get(i + 2) & 0xFF;
                        int a = buf.get(i + 3) & 0xFF;
                        if (a > 8) anyOpaque = true;
                        img.setRGB(x, y, (a << 24) | (r << 16) | (g << 8) | b);
                    }
                }
                if (!anyOpaque) img = null; // fully transparent = nothing rendered
            }

            fbo.unbindFramebuffer();
            return img;
        }
    }
}
