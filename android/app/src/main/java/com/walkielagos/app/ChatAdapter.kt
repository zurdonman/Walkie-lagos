package com.walkielagos.app

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.walkielagos.app.databinding.ItemChatBinding

/** Mensajes del canal: texto propio, de compañeros y avisos del sistema. */
class ChatAdapter(private val listener: Listener) : ListAdapter<ChatEntry, ChatAdapter.Holder>(Diff) {

    interface Listener {
        fun onChatLongPress(entry: ChatEntry)
    }

    object Diff : DiffUtil.ItemCallback<ChatEntry>() {
        override fun areItemsTheSame(a: ChatEntry, b: ChatEntry) = a.ts == b.ts && a.text == b.text
        override fun areContentsTheSame(a: ChatEntry, b: ChatEntry) = a == b
    }

    class Holder(val binding: ItemChatBinding) : RecyclerView.ViewHolder(binding.root)

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        Holder(ItemChatBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val entry = getItem(position)
        val binding = holder.binding
        binding.time.text = MainActivity.formatTime(entry.ts)
        if (entry.from == null) {
            // Aviso del sistema (entradas y salidas del canal).
            binding.who.visibility = View.GONE
            binding.text.text = entry.text
            binding.text.alpha = 0.6f
        } else {
            binding.who.visibility = View.VISIBLE
            binding.who.text = if (entry.mine) "${entry.from} (tú)" else entry.from
            binding.text.text = entry.text
            binding.text.alpha = 1f
        }
        binding.root.setOnLongClickListener {
            listener.onChatLongPress(entry)
            true
        }
    }

    fun setHistory(entries: List<ChatEntry>) {
        submitList(entries.takeLast(60))
    }

    fun add(entry: ChatEntry) {
        submitList((currentList + entry).takeLast(60))
    }

    fun clear() = submitList(emptyList())
}
